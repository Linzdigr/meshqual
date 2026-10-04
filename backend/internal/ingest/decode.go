package ingest

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"

	"github.com/yvanferez/meshqual/backend/internal/meshcore"
	"github.com/yvanferez/meshqual/backend/internal/source"
)

// Decoded is everything one observation yields.
type Decoded struct {
	Packet  *meshcore.Packet
	Advert  *meshcore.Advert
	Trace   *meshcore.Trace
	Samples []Sample

	// Attribution counters, so the API can state how much of the traffic could
	// not be pinned to a pair of known nodes instead of quietly dropping it.
	HopsTotal      int
	HopsUnresolved int
	HopsAmbiguous  int
	// LinksImplausible counts hop pairs dropped because their ends are too far
	// apart to be one radio hop (see Resolver.Plausible).
	LinksImplausible int
	WireHash         string
}

// Decode attributes one observation to zero or more link samples.
//
// SNR attribution is the crux. The firmware path field carries routing hashes
// only, so the observer's SNR describes exactly one link -- the last hop to the
// observer -- and nothing else. Adjacent hops therefore become topology samples
// with no signal value, and the only other real per-hop measurements come from
// TRACE packets. Spreading the observer's SNR across the whole path would
// produce a confident, wrong map.
func Decode(obs source.Observation, r *Resolver) (*Decoded, error) {
	pkt, err := meshcore.Decode(obs.Raw)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(obs.Raw)
	d := &Decoded{Packet: pkt, WireHash: strings.ToUpper(hex.EncodeToString(sum[:8]))}

	observer := strings.ToUpper(obs.ObserverKey)

	// An ADVERT is the only passive source of identity and position.
	if pkt.PayloadType() == meshcore.PayloadAdvert {
		if adv, err := pkt.DecodeAdvert(); err == nil {
			d.Advert = adv
			r.Upsert(Node{
				Key: adv.PublicKeyHex(), Name: adv.Name, NodeType: adv.NodeType,
				Latitude: adv.Latitude, Longitude: adv.Longitude,
				PathHashSize: AdvertHashSize(pkt),
			})
		}
	}

	base := Sample{
		At: obs.ReceivedAt, ObserverKey: observer,
		PayloadType: pkt.PayloadType(), RouteType: pkt.RouteType(),
		SourceID: obs.SourceID, WireHash: d.WireHash,
	}

	// TRACE: each forwarding node appended its own SNR, so every hop after the
	// first is a genuine per-link measurement.
	if pkt.IsTrace() {
		tr, err := pkt.DecodeTrace()
		if err != nil {
			return d, nil
		}
		d.Trace = tr
		keys := make([]Resolution, len(tr.Hops))
		for i, h := range tr.Hops {
			keys[i] = r.Resolve(h.Hash)
			d.HopsTotal++
			switch {
			case keys[i].Ambiguous:
				d.HopsAmbiguous++
			case keys[i].Key == "":
				d.HopsUnresolved++
			}
		}
		// Hop 0's SNR describes the originator -> hop0 link, and a trace's path
		// does not name the originator, so it cannot be attributed.
		for i := 1; i < len(tr.Hops); i++ {
			if tr.Hops[i].SNR == nil || !keys[i-1].Resolved() || !keys[i].Resolved() {
				continue
			}
			if !r.Plausible(keys[i-1].Key, keys[i].Key) {
				d.LinksImplausible++
				continue
			}
			s := base
			s.Kind = KindTrace
			s.SNR = tr.Hops[i].SNR
			s.HopIndex, s.HopCount = i, len(tr.Hops)
			s.AKey, s.BKey, s.Forward = order(keys[i-1].Key, keys[i].Key)
			d.Samples = append(d.Samples, s)
		}
		return d, nil
	}

	hops := pkt.Hops()

	res := make([]Resolution, len(hops))
	for i, h := range hops {
		res[i] = r.Resolve(h)
		d.HopsTotal++
		switch {
		case res[i].Ambiguous:
			d.HopsAmbiguous++
		case res[i].Key == "":
			d.HopsUnresolved++
		}
	}

	// Adjacent hops: topology only.
	for i := 0; i+1 < len(hops); i++ {
		if !res[i].Resolved() || !res[i+1].Resolved() {
			continue
		}
		if res[i].Key == res[i+1].Key {
			continue // a loop in the path is not a link
		}
		if !r.Plausible(res[i].Key, res[i+1].Key) {
			d.LinksImplausible++
			continue
		}
		s := base
		s.Kind = KindTopology
		s.HopIndex, s.HopCount = i, len(hops)
		s.AKey, s.BKey, s.Forward = order(res[i].Key, res[i+1].Key)
		d.Samples = append(d.Samples, s)
	}

	// The measured link: whoever transmitted last -> the observer.
	if observer == "" || obs.SNR == nil {
		return d, nil
	}
	var lastKey string
	switch {
	case len(hops) > 0:
		if res[len(res)-1].Resolved() {
			lastKey = res[len(res)-1].Key
		}
	case d.Advert != nil:
		// Zero hops and an advert: heard straight from the originator, whose key
		// is in the payload.
		lastKey = d.Advert.PublicKeyHex()
	}
	if lastKey == "" || lastKey == observer {
		return d, nil
	}
	if !r.Plausible(lastKey, observer) {
		d.LinksImplausible++
		return d, nil
	}
	s := base
	s.Kind = KindMeasured
	s.SNR, s.RSSI = obs.SNR, obs.RSSI
	s.HopIndex, s.HopCount = len(hops), len(hops)
	s.AKey, s.BKey, s.Forward = order(lastKey, observer)
	d.Samples = append(d.Samples, s)
	return d, nil
}

// AdvertHashSize is the path hash width an advert reveals about its originator,
// or 0 when it reveals nothing. A flood advert is sent with the node's
// path.hash.mode (+1), and relays keep that width. A zero-hop advert is sent
// DIRECT with path_len 0, which would read as 1 byte whatever the setting.
func AdvertHashSize(pkt *meshcore.Packet) uint8 {
	if !pkt.IsFlood() {
		return 0
	}
	return uint8(pkt.HashSize())
}

func order(from, to string) (a, b string, forward bool) {
	id, fwd := NewLinkID(from, to)
	return id.A, id.B, fwd
}
