package ingest

import (
	"context"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/yvanferez/meshqual/backend/internal/hub"
	"github.com/yvanferez/meshqual/backend/internal/meshcore"
	"github.com/yvanferez/meshqual/backend/internal/source"
)

// Sink is the subset of store.Store the pipeline writes through. Declaring it
// here keeps ingest independent of the storage package.
type Sink interface {
	WriteSamples(ctx context.Context, samples []Sample) error
	UpsertNodes(ctx context.Context, nodes []NodeUpsert) error
	// MarkRelayed records the latest time each node was seen relaying.
	MarkRelayed(ctx context.Context, at map[string]time.Time) error
}

// relaysOf is which ends of a sample were path hops, so relayed the packet
// (see Decode): both ends of a topology or trace sample, the non-observer end
// of a measured one past zero hops. At zero hops that end is the originator.
func relaysOf(s Sample) []string {
	// A companion's own report: a trace's hops relayed it, except the
	// companion at either end; a discovery proves no relaying at all.
	if s.SourceID == SourceCompanion {
		if s.PayloadType != meshcore.PayloadTrace {
			return nil
		}
		var out []string
		for _, k := range []string{s.AKey, s.BKey} {
			if k != s.ObserverKey {
				out = append(out, k)
			}
		}
		return out
	}
	switch {
	case s.Kind != KindMeasured:
		return []string{s.AKey, s.BKey}
	case s.HopCount == 0:
		return nil
	case s.AKey == s.ObserverKey:
		return []string{s.BKey}
	case s.BKey == s.ObserverKey:
		return []string{s.AKey}
	}
	return nil
}

// NodeUpsert is a node fact learned from an advert.
type NodeUpsert struct {
	Key             string
	Name            string
	NodeType        uint8
	Latitude        *float64
	Longitude       *float64
	AdvertTimestamp *int64
	PathHashSize    uint8
	RegionScope     RegionScope
	RegionName      string
}

// PipelineOptions configures the pipeline.
type PipelineOptions struct {
	FlushInterval time.Duration
	FlushSize     int
	PushInterval  time.Duration
	EvictInterval time.Duration
}

// Pipeline wires sources through decoding into the aggregator, the sink and the
// event hub.
type Pipeline struct {
	Resolver   *Resolver
	Aggregator *Aggregator

	sink Sink
	hub  *hub.Hub
	log  *slog.Logger
	opt  PipelineOptions

	decoded   atomic.Uint64
	decodeErr atomic.Uint64
	written   atomic.Uint64
	writeErr  atomic.Uint64

	mu        sync.Mutex
	sampleBuf []Sample
	nodeBuf   map[string]NodeUpsert

	traces *TraceDedup
}

// NewPipeline builds a pipeline.
func NewPipeline(r *Resolver, a *Aggregator, sink Sink, h *hub.Hub, opt PipelineOptions, log *slog.Logger) *Pipeline {
	if opt.FlushInterval <= 0 {
		opt.FlushInterval = 2 * time.Second
	}
	if opt.FlushSize <= 0 {
		opt.FlushSize = 500
	}
	if opt.PushInterval <= 0 {
		opt.PushInterval = 2 * time.Second
	}
	if opt.EvictInterval <= 0 {
		opt.EvictInterval = time.Minute
	}
	return &Pipeline{
		Resolver: r, Aggregator: a, sink: sink, hub: h, opt: opt, log: log,
		nodeBuf: make(map[string]NodeUpsert),
		traces:  NewTraceDedup(15 * time.Minute),
	}
}

// AddCompanionSamples records measurements a companion radio returned to the
// browser that drives it: the full result of a trace, or a discovery. Hops an
// observer already reported for the same trace (tag) are skipped, as are
// later observer reports of these. Returns how many were kept.
func (p *Pipeline) AddCompanionSamples(tag uint32, samples []Sample) int {
	kept := samples[:0:0]
	for _, s := range samples {
		if p.traces.First(tag, sampleFrom(s), sampleTo(s), time.Now()) {
			kept = append(kept, s)
		}
	}
	if len(kept) == 0 {
		return 0
	}
	for _, s := range kept {
		p.Resolver.Touch(s.AKey, s.At)
		p.Resolver.Touch(s.BKey, s.At)
		for _, k := range relaysOf(s) {
			p.Resolver.MarkRelay(k, s.At)
		}
	}
	p.Aggregator.Add(&Decoded{Samples: kept})
	p.mu.Lock()
	p.sampleBuf = append(p.sampleBuf, kept...)
	p.mu.Unlock()
	return len(kept)
}

// Stats reports pipeline counters for /api/health.
type Stats struct {
	Decoded      uint64 `json:"decoded"`
	DecodeErrors uint64 `json:"decodeErrors"`
	Written      uint64 `json:"written"`
	WriteErrors  uint64 `json:"writeErrors"`
}

// Stats returns the counters.
func (p *Pipeline) Stats() Stats {
	return Stats{
		Decoded: p.decoded.Load(), DecodeErrors: p.decodeErr.Load(),
		Written: p.written.Load(), WriteErrors: p.writeErr.Load(),
	}
}

// Run consumes observations until in is closed or ctx is cancelled. It owns the
// flush, push and eviction timers.
func (p *Pipeline) Run(ctx context.Context, in <-chan source.Observation) {
	flush := time.NewTicker(p.opt.FlushInterval)
	push := time.NewTicker(p.opt.PushInterval)
	evict := time.NewTicker(p.opt.EvictInterval)
	defer flush.Stop()
	defer push.Stop()
	defer evict.Stop()

	for {
		select {
		case <-ctx.Done():
			p.flush(context.WithoutCancel(ctx))
			return

		case obs, ok := <-in:
			if !ok {
				p.flush(context.WithoutCancel(ctx))
				return
			}
			p.handle(obs)

		case <-flush.C:
			p.flush(ctx)

		case <-push.C:
			p.push()

		case <-evict.C:
			if n := p.Aggregator.Evict(time.Now().UTC()); n > 0 {
				p.log.Debug("evicted stale links", "count", n)
			}
		}
	}
}

func (p *Pipeline) handle(obs source.Observation) {
	d, err := Decode(obs, p.Resolver)
	if err != nil {
		p.decodeErr.Add(1)
		return
	}
	p.decoded.Add(1)
	// An observer hears a trace at each retransmission, each carrying the
	// SNR of every hop before: keep each hop once per trace.
	if d.Trace != nil {
		kept := d.Samples[:0]
		for _, s := range d.Samples {
			if p.traces.First(d.Trace.Tag, sampleFrom(s), sampleTo(s), s.At) {
				kept = append(kept, s)
			}
		}
		d.Samples = kept
	}
	p.Aggregator.Add(d)

	p.mu.Lock()
	p.sampleBuf = append(p.sampleBuf, d.Samples...)
	if d.Advert != nil {
		ts := int64(d.Advert.Timestamp)
		k := d.Advert.PublicKeyHex()
		p.nodeBuf[k] = NodeUpsert{
			Key: k, Name: d.Advert.Name, NodeType: d.Advert.NodeType,
			Latitude: d.Advert.Latitude, Longitude: d.Advert.Longitude, AdvertTimestamp: &ts,
			PathHashSize: AdvertHashSize(d.Packet),
			RegionScope:  AdvertScope(d.Packet),
			RegionName:   p.Resolver.Regions.Match(d.Packet),
		}
	}
	full := len(p.sampleBuf) >= p.opt.FlushSize
	p.mu.Unlock()

	// Per-frame events go only to clients watching this exact link, so an idle
	// map never pays for a busy one.
	if p.hub != nil {
		for _, s := range d.Samples {
			id := s.ID()
			frames := p.Aggregator.Frames(id, 1)
			if len(frames) == 0 {
				continue
			}
			if e, err := hub.NewEvent("frame", map[string]any{
				"linkId": id.String(), "frame": frames[0],
			}); err == nil {
				p.hub.BroadcastTo(id.String(), e)
			}
		}
	}

	if full {
		go p.flush(context.Background())
	}
}

// flush writes the buffered samples and node facts.
func (p *Pipeline) flush(ctx context.Context) {
	p.mu.Lock()
	samples := p.sampleBuf
	p.sampleBuf = nil
	nodes := make([]NodeUpsert, 0, len(p.nodeBuf))
	for _, n := range p.nodeBuf {
		nodes = append(nodes, n)
	}
	p.nodeBuf = make(map[string]NodeUpsert)
	p.mu.Unlock()

	if len(samples) == 0 && len(nodes) == 0 {
		return
	}
	writeCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	relayed := map[string]time.Time{}
	for _, s := range samples {
		for _, k := range relaysOf(s) {
			if s.At.After(relayed[k]) {
				relayed[k] = s.At
			}
		}
	}

	if len(nodes) > 0 {
		if err := p.sink.UpsertNodes(writeCtx, nodes); err != nil {
			p.writeErr.Add(1)
			p.log.Warn("node upsert failed", "count", len(nodes), "err", err)
		}
	}
	if len(relayed) > 0 {
		if err := p.sink.MarkRelayed(writeCtx, relayed); err != nil {
			p.writeErr.Add(1)
			p.log.Warn("relay mark failed", "count", len(relayed), "err", err)
		}
	}
	if len(samples) > 0 {
		if err := p.sink.WriteSamples(writeCtx, samples); err != nil {
			p.writeErr.Add(1)
			p.log.Warn("sample write failed", "count", len(samples), "err", err)
			return
		}
		p.written.Add(uint64(len(samples)))
	}
}

// push tells clients which links changed, so the map patches those features
// instead of refetching the whole bbox.
func (p *Pipeline) push() {
	if p.hub == nil {
		return
	}
	dirty := p.Aggregator.TakeDirty()
	if len(dirty) == 0 {
		return
	}
	ids := make([]string, len(dirty))
	for i, id := range dirty {
		ids[i] = id.String()
	}
	if e, err := hub.NewEvent("links:changed", map[string]any{
		"at": time.Now().UTC(), "links": ids,
	}); err == nil {
		p.hub.Broadcast(e)
	}
}

// WarmFromSamples replays persisted samples into the aggregator at startup so a
// restart does not blank the map for a full window. It returns how many samples
// were dropped as implausible.
func (p *Pipeline) WarmFromSamples(samples []Sample) (dropped int) {
	// Oldest first, so the frame rings end up in the right order.
	for i := len(samples) - 1; i >= 0; i-- {
		// Stored samples predate any change to MaxHopKm, so check them again.
		if !p.Resolver.Plausible(samples[i].AKey, samples[i].BKey) {
			dropped++
			continue
		}
		// Both ends and the observer were heard when the sample was taken; the
		// ends that were path hops relayed.
		s := samples[i]
		p.Resolver.Touch(s.AKey, s.At)
		p.Resolver.Touch(s.BKey, s.At)
		for _, k := range relaysOf(s) {
			p.Resolver.MarkRelay(k, s.At)
		}
		p.Resolver.MarkObserver(s.ObserverKey, s.At)
		p.Aggregator.Add(&Decoded{Samples: []Sample{samples[i]}})
	}
	p.Aggregator.TakeDirty() // a warm-up is not a change to push
	return dropped
}
