package api

// GeoJSON types, hand-rolled so the handler can stream exactly the properties
// the map styles read and nothing else. MapLibre consumes this shape directly:
// the links layer is a GeoJSON source and a refresh is one setData call.

// FeatureCollection is a GeoJSON FeatureCollection.
type FeatureCollection struct {
	Type     string    `json:"type"`
	Features []Feature `json:"features"`
	Meta     *Meta     `json:"meta,omitempty"`
}

// Feature is a GeoJSON Feature.
type Feature struct {
	Type       string         `json:"type"`
	ID         string         `json:"id,omitempty"`
	Geometry   Geometry       `json:"geometry"`
	Properties map[string]any `json:"properties"`
}

// Geometry is a GeoJSON geometry. Coordinates are [lng, lat] for a Point and
// [[lng, lat], ...] for a LineString.
type Geometry struct {
	Type        string `json:"type"`
	Coordinates any    `json:"coordinates"`
}

// Meta travels with the collection so the UI can state its own limits: how much
// of the observed traffic could not be attributed, and whether the result was
// truncated.
type Meta struct {
	GeneratedAt     string  `json:"generatedAt"`
	Window          string  `json:"window"`
	Total           int     `json:"total"`
	Returned        int     `json:"returned"`
	Truncated       bool    `json:"truncated"`
	WithoutPosition int     `json:"withoutPosition"`
	UnresolvedShare float64 `json:"unresolvedShare"`
	AmbiguousShare  float64 `json:"ambiguousShare"`
}

func newCollection(n int) *FeatureCollection {
	return &FeatureCollection{Type: "FeatureCollection", Features: make([]Feature, 0, n)}
}

func lineFeature(id string, a, b [2]float64, props map[string]any) Feature {
	return Feature{
		Type: "Feature", ID: id,
		Geometry:   Geometry{Type: "LineString", Coordinates: [][2]float64{a, b}},
		Properties: props,
	}
}

func pointFeature(id string, p [2]float64, props map[string]any) Feature {
	return Feature{
		Type: "Feature", ID: id,
		Geometry:   Geometry{Type: "Point", Coordinates: p},
		Properties: props,
	}
}
