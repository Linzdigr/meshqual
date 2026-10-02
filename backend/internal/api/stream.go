package api

import (
	"fmt"
	"net/http"
	"time"
)

// stream is the SSE endpoint.
//
// ?link=AKEY:BKEY subscribes to the per-frame stream for one link; map-wide
// "links:changed" events are always delivered. Keeping the high-rate stream
// behind an explicit follow means an open map costs one event per push interval
// however busy the mesh is.
func (s *Server) stream(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		httpError(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}

	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache, no-transform")
	h.Set("Connection", "keep-alive")
	// Tells nginx not to buffer the stream. Caddy needs no equivalent.
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	sub := s.d.Hub.Subscribe()
	defer sub.Close()
	if link := r.URL.Query().Get("link"); link != "" {
		sub.Follow(link)
	}

	// Tell the client the server's cadence so it can size its own debounce.
	fmt.Fprintf(w, "retry: %d\n\n", 3000)
	fmt.Fprintf(w, "event: hello\ndata: {\"pushIntervalMs\":%d}\n\n", s.d.PushInterval.Milliseconds())
	flusher.Flush()

	// A comment line every 25s keeps idle proxies from closing the connection.
	keepalive := time.NewTicker(25 * time.Second)
	defer keepalive.Stop()

	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case <-keepalive.C:
			fmt.Fprint(w, ": keepalive\n\n")
			flusher.Flush()
		case ev, open := <-sub.Events():
			if !open {
				return
			}
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", ev.Name, ev.Data)
			flusher.Flush()
		}
	}
}
