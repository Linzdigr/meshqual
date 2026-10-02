package ingest

import "time"

// Kind is how a link sample was obtained. The distinction is the whole point of
// the model: only two of the three carry a real signal measurement.
type Kind uint8

const (
	// KindTopology: two adjacent hops in an observed path. Proves the pair can
	// hear each other, carries NO signal quality -- the path field holds only
	// routing hashes.
	KindTopology Kind = 0
	// KindMeasured: the last hop in the path to the observer that received the
	// frame. The observer's own radio measured this one, so SNR and RSSI are real.
	KindMeasured Kind = 1
	// KindTrace: a hop-by-hop SNR reported inside a TRACE packet, where each
	// forwarding node appends its own measurement. Authoritative per hop, but
	// only present when someone actively runs a trace.
	KindTrace Kind = 2
)

func (k Kind) String() string {
	switch k {
	case KindMeasured:
		return "measured"
	case KindTrace:
		return "trace"
	default:
		return "topology"
	}
}

// ParseKind maps the API spelling back to a Kind.
func ParseKind(s string) (Kind, bool) {
	switch s {
	case "topology":
		return KindTopology, true
	case "measured":
		return KindMeasured, true
	case "trace":
		return KindTrace, true
	}
	return 0, false
}

// HasSNR reports whether samples of this kind carry a signal measurement.
func (k Kind) HasSNR() bool { return k == KindMeasured || k == KindTrace }

// Sample is one attributed observation of one link.
type Sample struct {
	At      time.Time
	AKey    string // canonical: AKey < BKey
	BKey    string
	Forward bool // true when the frame travelled A -> B
	Kind    Kind

	SNR  *float64
	RSSI *int

	ObserverKey string
	PayloadType uint8
	RouteType   uint8
	HopIndex    int
	HopCount    int
	SourceID    string
	WireHash    string
}

// LinkID is the canonical identity of an unordered pair.
type LinkID struct{ A, B string }

// ID returns the sample's canonical link id.
func (s Sample) ID() LinkID { return LinkID{A: s.AKey, B: s.BKey} }

// String renders the link id as "AKEY:BKEY".
func (l LinkID) String() string { return l.A + ":" + l.B }

// NewLinkID orders a pair canonically and reports whether the input order was
// already canonical (i.e. the sample is "forward").
func NewLinkID(from, to string) (LinkID, bool) {
	if from <= to {
		return LinkID{A: from, B: to}, true
	}
	return LinkID{A: to, B: from}, false
}
