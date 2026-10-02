package source

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"sync"
	"sync/atomic"
	"time"

	"github.com/eclipse/paho.golang/autopaho"
	"github.com/eclipse/paho.golang/paho"
)

// MQTTConfig describes one broker to ingest from.
type MQTTConfig struct {
	ID        string   `json:"id"`
	Enabled   *bool    `json:"enabled"`   // nil means enabled
	BrokerURL string   `json:"brokerUrl"` // mqtts://host:8883, ws://, wss://
	Username  string   `json:"username"`
	Password  string   `json:"password"`
	ClientID  string   `json:"clientId"`
	Topics    []string `json:"topics"` // defaults to meshcore/+/+/packets
	// QueueSize bounds the in-flight buffer before the pipeline. A full queue
	// drops the newest sample and increments Dropped, rather than blocking the
	// MQTT read loop and stalling every other source.
	QueueSize int `json:"queueSize"`
}

// IsEnabled reports whether the source should be started.
func (c MQTTConfig) IsEnabled() bool { return c.Enabled == nil || *c.Enabled }

const defaultTopic = "meshcore/+/+/packets"

// MQTTSource ingests observations from one MQTT broker.
type MQTTSource struct {
	cfg MQTTConfig
	log *slog.Logger

	connected atomic.Bool
	received  atomic.Uint64
	dropped   atomic.Uint64
	decodeErr atomic.Uint64

	mu        sync.Mutex
	lastMsgAt time.Time
	lastErr   string
}

// NewMQTT validates the config and returns a Source.
func NewMQTT(cfg MQTTConfig, log *slog.Logger) (*MQTTSource, error) {
	if cfg.ID == "" {
		return nil, errors.New("source: mqtt id is required")
	}
	if cfg.BrokerURL == "" {
		return nil, fmt.Errorf("source %s: brokerUrl is required", cfg.ID)
	}
	if _, err := url.Parse(cfg.BrokerURL); err != nil {
		return nil, fmt.Errorf("source %s: bad brokerUrl: %w", cfg.ID, err)
	}
	if len(cfg.Topics) == 0 {
		cfg.Topics = []string{defaultTopic}
	}
	if cfg.ClientID == "" {
		cfg.ClientID = "meshqual-" + cfg.ID
	}
	if cfg.QueueSize <= 0 {
		cfg.QueueSize = 4096
	}
	return &MQTTSource{cfg: cfg, log: log.With("source", cfg.ID)}, nil
}

func (s *MQTTSource) ID() string { return s.cfg.ID }

func (s *MQTTSource) Stats() Stats {
	s.mu.Lock()
	last, lastErr := s.lastMsgAt, s.lastErr
	s.mu.Unlock()
	st := Stats{
		ID: s.cfg.ID, Kind: "mqtt",
		Connected: s.connected.Load(),
		Received:  s.received.Load(),
		Dropped:   s.dropped.Load(),
		DecodeErr: s.decodeErr.Load(),
		LastError: lastErr,
	}
	if !last.IsZero() {
		st.LastMsgAt = &last
	}
	return st
}

func (s *MQTTSource) note(err error) {
	s.mu.Lock()
	s.lastErr = err.Error()
	s.mu.Unlock()
}

// Run connects and streams until ctx is cancelled. autopaho handles reconnection
// and re-subscription on its own, so there is no retry loop here.
func (s *MQTTSource) Run(ctx context.Context, out chan<- Observation) error {
	u, err := url.Parse(s.cfg.BrokerURL)
	if err != nil {
		return err
	}

	subs := make([]paho.SubscribeOptions, 0, len(s.cfg.Topics))
	for _, t := range s.cfg.Topics {
		subs = append(subs, paho.SubscribeOptions{Topic: t, QoS: 0})
	}

	cliCfg := autopaho.ClientConfig{
		ServerUrls:                    []*url.URL{u},
		KeepAlive:                     30,
		CleanStartOnInitialConnection: true,
		SessionExpiryInterval:         60,
		ConnectUsername:               s.cfg.Username,
		ConnectPassword:               []byte(s.cfg.Password),
		OnConnectionUp: func(cm *autopaho.ConnectionManager, _ *paho.Connack) {
			s.connected.Store(true)
			if _, err := cm.Subscribe(ctx, &paho.Subscribe{Subscriptions: subs}); err != nil {
				s.log.Error("subscribe failed", "err", err)
				s.note(err)
				return
			}
			s.log.Info("connected", "broker", u.Redacted(), "topics", s.cfg.Topics)
		},
		OnConnectError: func(err error) {
			s.connected.Store(false)
			s.note(err)
			s.log.Warn("connect error", "err", err)
		},
		ClientConfig: paho.ClientConfig{
			ClientID: s.cfg.ClientID,
			OnPublishReceived: []func(paho.PublishReceived) (bool, error){
				func(pr paho.PublishReceived) (bool, error) {
					s.handle(ctx, pr.Packet, out)
					return true, nil
				},
			},
			OnClientError: func(err error) {
				s.connected.Store(false)
				s.note(err)
			},
		},
	}

	cm, err := autopaho.NewConnection(ctx, cliCfg)
	if err != nil {
		return fmt.Errorf("source %s: %w", s.cfg.ID, err)
	}
	<-ctx.Done()
	s.connected.Store(false)

	shutdown, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = cm.Disconnect(shutdown)
	return nil
}

func (s *MQTTSource) handle(ctx context.Context, pub *paho.Publish, out chan<- Observation) {
	obs, err := parseObservation(s.cfg.ID, pub.Topic, pub.Payload, time.Now().UTC())
	if err != nil {
		if !errors.Is(err, errNotAPacket) {
			s.decodeErr.Add(1)
			s.log.Debug("unusable message", "topic", pub.Topic, "err", err)
		}
		return
	}
	s.received.Add(1)
	s.mu.Lock()
	s.lastMsgAt = time.Now().UTC()
	s.mu.Unlock()

	select {
	case out <- obs:
	case <-ctx.Done():
	default:
		// Shedding load here is deliberate: a backed-up pipeline must not become
		// backpressure on the broker connection.
		s.dropped.Add(1)
	}
}
