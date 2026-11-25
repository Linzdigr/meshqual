package api

import (
	"encoding/hex"
	"net/http"
	"strings"
	"time"

	"github.com/yvanferez/meshqual/backend/internal/ingest"
	"github.com/yvanferez/meshqual/backend/internal/meshcore"
	"github.com/yvanferez/meshqual/backend/internal/store"
)

// packetLookback bounds /api/packets/{hash} to the receptions not yet
// compressed (observations compress after 7 days): a hash lookup in a
// compressed chunk scans all of it.
const packetLookback = 7 * 24 * time.Hour

// packetMaxReceptions caps one packet's receptions: a flood heard by every
// observer of a busy mesh is a few dozen.
const packetMaxReceptions = 500

// PacketHop is a node of a packet's way: a path hop, the originator or an
// observer. Key, Name and position are set when the hash names one known node.
type PacketHop struct {
	Hash      string   `json:"hash,omitempty"`
	Key       string   `json:"key,omitempty"`
	Name      string   `json:"name,omitempty"`
	Lat       *float64 `json:"lat,omitempty"`
	Lon       *float64 `json:"lon,omitempty"`
	Ambiguous bool     `json:"ambiguous,omitempty"`
}

// PacketReception is one observer's copy of the packet.
type PacketReception struct {
	At       time.Time `json:"at"`
	Observer PacketHop `json:"observer"`
	// Route: "flood", the hops relayed it in order; "direct", the hops are
	// the route still ahead (each relay strips itself off).
	Route string      `json:"route"`
	Hops  []PacketHop `json:"hops"`
	SNR   *float64    `json:"snr,omitempty"`
	RSSI  *int        `json:"rssi,omitempty"`
}

// PacketTrace is every reception of one packet.
type PacketTrace struct {
	Hash        string            `json:"hash"`
	PayloadType string            `json:"payloadType"`
	Origin      *PacketHop        `json:"origin,omitempty"`
	Receptions  []PacketReception `json:"receptions"`
}

// parsePacketHash accepts the firmware hash in full: 16 hex digits.
func parsePacketHash(s string) (string, bool) {
	s = strings.ToUpper(strings.TrimSpace(s))
	if len(s) != 2*meshcore.PacketHashSize {
		return "", false
	}
	if _, err := hex.DecodeString(s); err != nil {
		return "", false
	}
	return s, true
}

func nodeHop(r *ingest.Resolver, key string) PacketHop {
	h := PacketHop{Key: key}
	if n, ok := r.Get(key); ok {
		h.Name, h.Lat, h.Lon = n.Name, n.Latitude, n.Longitude
	}
	return h
}

// buildPacketTrace names the hops and observers of the receptions with what
// the resolver knows now.
func buildPacketTrace(hash string, rows []store.ObservationRow, r *ingest.Resolver) PacketTrace {
	t := PacketTrace{Hash: hash, Receptions: make([]PacketReception, 0, len(rows))}
	for _, row := range rows {
		if t.PayloadType == "" {
			t.PayloadType = meshcore.PayloadName(row.PayloadType)
		}
		if t.Origin == nil && row.OriginKey != "" {
			o := nodeHop(r, row.OriginKey)
			t.Origin = &o
		}
		rec := PacketReception{At: row.At, SNR: row.SNR, RSSI: row.RSSI, Route: "flood", Hops: []PacketHop{}}
		if row.ObserverKey != "" {
			rec.Observer = nodeHop(r, row.ObserverKey)
		}
		if row.RouteType == meshcore.RouteDirect || row.RouteType == meshcore.RouteTransportDirect {
			rec.Route = "direct"
		}
		// A TRACE's path holds SNR bytes, not hops.
		if row.PayloadType != meshcore.PayloadTrace && row.HashSize > 0 {
			for i := 0; i+row.HashSize <= len(row.Path); i += row.HashSize {
				raw := row.Path[i : i+row.HashSize]
				hop := PacketHop{Hash: strings.ToUpper(hex.EncodeToString(raw))}
				res := r.Resolve(meshcore.NewHash(raw))
				switch {
				case res.Resolved():
					named := nodeHop(r, res.Key)
					named.Hash = hop.Hash
					hop = named
				case res.Ambiguous:
					hop.Ambiguous = true
				}
				rec.Hops = append(rec.Hops, hop)
			}
		}
		t.Receptions = append(t.Receptions, rec)
	}
	return t
}

// packet serves GET /api/packets/{hash}: every reception of one packet in the
// last packetLookback, to draw the way it went.
func (s *Server) packet(w http.ResponseWriter, r *http.Request) {
	hash, ok := parsePacketHash(r.PathValue("hash"))
	if !ok {
		httpError(w, http.StatusBadRequest, "a packet hash is 16 hex digits")
		return
	}
	rows, err := s.d.Store.PacketReceptions(r.Context(), hash, time.Now().Add(-packetLookback), packetMaxReceptions)
	if err != nil {
		s.d.Log.Warn("packet lookup failed", "hash", hash, "err", err)
		httpError(w, http.StatusInternalServerError, "lookup failed")
		return
	}
	if len(rows) == 0 {
		httpError(w, http.StatusNotFound, "packet not heard in the last 7 days")
		return
	}
	writeJSON(w, http.StatusOK, buildPacketTrace(hash, rows, s.d.Resolver))
}
