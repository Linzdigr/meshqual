// Command relayd ingests MeshCore observer traffic and serves the link-quality API.
package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/yvanferez/meshqual/backend/internal/api"
	"github.com/yvanferez/meshqual/backend/internal/config"
	"github.com/yvanferez/meshqual/backend/internal/hub"
	"github.com/yvanferez/meshqual/backend/internal/ingest"
	"github.com/yvanferez/meshqual/backend/internal/source"
	"github.com/yvanferez/meshqual/backend/internal/store"
)

// version is overridden at build time: -ldflags "-X main.version=$(git describe)".
var version = "dev"

func main() {
	cfgPath := flag.String("config", os.Getenv("MESHQUAL_CONFIG"), "path to config JSON")
	flag.Parse()

	cfg, err := config.Load(*cfgPath)
	log := newLogger(cfg.LogLevel)
	if err != nil {
		log.Error("configuration error", "err", err)
		os.Exit(1)
	}

	if err := run(cfg, log); err != nil {
		log.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func newLogger(level string) *slog.Logger {
	var l slog.Level
	if err := l.UnmarshalText([]byte(level)); err != nil {
		l = slog.LevelInfo
	}
	return slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: l}))
}

func run(cfg config.Config, log *slog.Logger) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Storage is optional: with no DSN the service runs entirely in memory. The
	// map still works; nothing survives a restart.
	var st store.Store = store.Noop{}
	if cfg.DSN != "" {
		pg, err := store.Open(ctx, cfg.DSN, log)
		if err != nil {
			return err
		}
		defer pg.Close()
		if err := pg.Migrate(ctx); err != nil {
			return err
		}
		st = pg
	} else {
		log.Warn("no DSN configured: running in memory only, nothing is persisted")
	}

	resolver := ingest.NewResolver()
	resolver.MaxHopKm = cfg.MaxHopKm
	aggregator := ingest.NewAggregator(cfg.FramesPerLink, cfg.SNRSamplesPerLink, cfg.LiveWindow.D())
	events := hub.New(64)

	// Warm up from storage so a restart does not blank the map for a full window.
	if nodes, err := st.LoadNodes(ctx); err != nil {
		log.Warn("could not load nodes", "err", err)
	} else if len(nodes) > 0 {
		for _, n := range nodes {
			resolver.Upsert(ingest.Node{
				Key: n.Key, Name: n.Name, NodeType: n.NodeType,
				Latitude: n.Latitude, Longitude: n.Longitude,
			})
		}
		log.Info("resolver warmed", "nodes", len(nodes))
	}

	pipeline := ingest.NewPipeline(resolver, aggregator, store.Sink{S: st}, events,
		ingest.PipelineOptions{
			FlushInterval: cfg.FlushInterval.D(),
			FlushSize:     cfg.FlushSize,
			PushInterval:  cfg.PushInterval.D(),
		}, log)

	if samples, err := st.LoadRecentSamples(ctx, time.Now().UTC().Add(-cfg.LiveWindow.D()), 500_000); err != nil {
		log.Warn("could not warm link table", "err", err)
	} else if len(samples) > 0 {
		dropped := pipeline.WarmFromSamples(samples)
		log.Info("link table warmed", "samples", len(samples), "implausible", dropped,
			"links", aggregator.Health().Links)
	}

	sources, err := buildSources(cfg, log)
	if err != nil {
		return err
	}
	if len(sources) == 0 {
		log.Warn("no sources configured: the API will serve an empty map")
	}

	// One shared channel: the pipeline is the single writer to the aggregator, so
	// nothing downstream needs its own locking for ordering.
	obs := make(chan source.Observation, 8192)

	var wg sync.WaitGroup
	for _, src := range sources {
		wg.Add(1)
		go func(s source.Source) {
			defer wg.Done()
			if err := s.Run(ctx, obs); err != nil && !errors.Is(err, context.Canceled) {
				log.Error("source stopped", "source", s.ID(), "err", err)
			}
		}(src)
	}

	pipelineDone := make(chan struct{})
	go func() {
		defer close(pipelineDone)
		pipeline.Run(ctx, obs)
	}()

	handler := api.New(api.Deps{
		Resolver: resolver, Aggregator: aggregator, Pipeline: pipeline,
		Store: st, Hub: events, Sources: sources, Log: log,
		CORSOrigins: cfg.CORSOrigins, PushInterval: cfg.PushInterval.D(),
		LiveWindow: cfg.LiveWindow.D(), FramesMax: cfg.FramesPerLink,
		Version: version, StartedAt: time.Now().UTC(),
	})

	srv := &http.Server{
		Addr:    cfg.Addr,
		Handler: handler,
		// No WriteTimeout: it would cut the SSE stream. ReadHeaderTimeout still
		// protects against a slow-header client.
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	serverErr := make(chan error, 1)
	go func() {
		log.Info("listening", "addr", cfg.Addr, "version", version)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serverErr <- err
		}
	}()

	select {
	case err := <-serverErr:
		return err
	case <-ctx.Done():
		log.Info("shutting down")
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Warn("http shutdown", "err", err)
	}

	// Let the sources drain before closing the channel the pipeline reads.
	wg.Wait()
	close(obs)
	<-pipelineDone
	log.Info("stopped")
	return nil
}

func buildSources(cfg config.Config, log *slog.Logger) ([]source.Source, error) {
	var out []source.Source
	for _, mc := range cfg.Sources {
		s, err := source.NewMQTT(mc, log)
		if err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	if cfg.ReplayFile != "" {
		r := source.NewReplay("replay", cfg.ReplayFile)
		r.Speed, r.Loop = cfg.ReplaySpeed, cfg.ReplayLoop
		out = append(out, r)
	}
	return out, nil
}
