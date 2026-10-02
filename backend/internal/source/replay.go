package source

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"sync/atomic"
	"time"
)

// ReplaySource feeds observations from a newline-delimited JSON file. It exists
// so the pipeline, the aggregation and the API can be exercised end to end with
// no broker and no hardware, and so a production incident can be replayed.
type ReplaySource struct {
	id   string
	path string

	running  atomic.Bool
	received atomic.Uint64
	bad      atomic.Uint64
	mu       sync.Mutex
	lastAt   time.Time
	lastErr  string
	// Speed > 0 replays with the original inter-arrival gaps divided by Speed;
	// 0 replays as fast as the pipeline accepts.
	Speed float64
	Loop  bool
}

// NewReplay returns a Source reading from an NDJSON capture file.
func NewReplay(id, path string) *ReplaySource {
	return &ReplaySource{id: id, path: path}
}

func (r *ReplaySource) ID() string { return r.id }

// Stats implements Reporter so a replay shows up in /api/health like a broker.
func (r *ReplaySource) Stats() Stats {
	r.mu.Lock()
	last, lastErr := r.lastAt, r.lastErr
	r.mu.Unlock()
	st := Stats{
		ID: r.id, Kind: "replay", Connected: r.running.Load(),
		Received: r.received.Load(), DecodeErr: r.bad.Load(), LastError: lastErr,
	}
	if !last.IsZero() {
		st.LastMsgAt = &last
	}
	return st
}

func (r *ReplaySource) note(err error) {
	r.mu.Lock()
	r.lastErr = err.Error()
	r.mu.Unlock()
}

type replayLine struct {
	Topic   string          `json:"topic"`
	Payload json.RawMessage `json:"payload"`
	// Offset is milliseconds since the start of the capture.
	Offset int64 `json:"offsetMs"`
}

func (r *ReplaySource) Run(ctx context.Context, out chan<- Observation) error {
	r.running.Store(true)
	defer r.running.Store(false)
	for {
		if err := r.once(ctx, out); err != nil {
			r.note(err)
			return err
		}
		if !r.Loop {
			return nil
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(time.Second):
		}
	}
}

func (r *ReplaySource) once(ctx context.Context, out chan<- Observation) error {
	f, err := os.Open(r.path)
	if err != nil {
		return fmt.Errorf("replay %s: %w", r.id, err)
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	var prev int64
	for sc.Scan() {
		if ctx.Err() != nil {
			return nil
		}
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		var rl replayLine
		if err := json.Unmarshal(line, &rl); err != nil {
			r.bad.Add(1)
			continue
		}
		if r.Speed > 0 && rl.Offset > prev {
			d := time.Duration(float64(rl.Offset-prev)/r.Speed) * time.Millisecond
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(d):
			}
		}
		prev = rl.Offset

		obs, err := parseObservation(r.id, rl.Topic, rl.Payload, time.Now().UTC())
		if err != nil {
			r.bad.Add(1)
			continue
		}
		r.received.Add(1)
		r.mu.Lock()
		r.lastAt = time.Now().UTC()
		r.mu.Unlock()
		select {
		case out <- obs:
		case <-ctx.Done():
			return nil
		}
	}
	return sc.Err()
}
