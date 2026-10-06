package los

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"sync"
	"time"

	"github.com/yvanferez/meshqual/backend/internal/geo"
)

// ErrNoCoverage means the elevation service has no data for part of the path:
// IGN covers France only.
var ErrNoCoverage = errors.New("los: no elevation data for this path")

// IGN fetches ground profiles from the Géoplateforme altimetry service
// (elevationLine), free and keyless, and caches them: the ground does not move.
type IGN struct {
	BaseURL  string // .../altimetrie/1.0/calcul/alti/rest/elevationLine.json
	Resource string // elevation model, e.g. ign_rge_alti_wld
	Client   *http.Client

	mu    sync.Mutex
	cache map[string][]Point
}

// maxCached bounds the cache; past it the cache is simply emptied, which is
// fine for a few hundred live links.
const maxCached = 2000

// NewIGN returns a client for the given service URL and elevation model.
func NewIGN(baseURL, resource string) *IGN {
	return &IGN{
		BaseURL: baseURL, Resource: resource,
		Client: &http.Client{Timeout: 15 * time.Second},
		cache:  map[string][]Point{},
	}
}

// Profile returns n ground samples from (latA, lonA) to (latB, lonB).
func (c *IGN) Profile(ctx context.Context, latA, lonA, latB, lonB float64, n int) ([]Point, error) {
	key := fmt.Sprintf("%.6f,%.6f,%.6f,%.6f,%d", latA, lonA, latB, lonB, n)
	c.mu.Lock()
	if p, ok := c.cache[key]; ok {
		c.mu.Unlock()
		return p, nil
	}
	c.mu.Unlock()

	q := url.Values{}
	q.Set("lon", fmt.Sprintf("%.6f|%.6f", lonA, lonB))
	q.Set("lat", fmt.Sprintf("%.6f|%.6f", latA, latB))
	q.Set("resource", c.Resource)
	q.Set("sampling", strconv.Itoa(n))
	q.Set("profile_mode", "simple")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+"?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	res, err := c.Client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("los: elevation service: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("los: elevation service: HTTP %d", res.StatusCode)
	}
	var body struct {
		Elevations []struct {
			Lon float64 `json:"lon"`
			Lat float64 `json:"lat"`
			Z   float64 `json:"z"`
		} `json:"elevations"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		return nil, fmt.Errorf("los: elevation service: %w", err)
	}
	if len(body.Elevations) < 2 {
		return nil, ErrNoCoverage
	}
	pts := make([]Point, len(body.Elevations))
	for i, e := range body.Elevations {
		// The service answers -99999 where it has no data.
		if e.Z < -1000 {
			return nil, ErrNoCoverage
		}
		pts[i] = Point{DistM: geo.HaversineKm(latA, lonA, e.Lat, e.Lon) * 1000, GroundM: e.Z}
	}

	c.mu.Lock()
	if len(c.cache) >= maxCached {
		c.cache = map[string][]Point{}
	}
	c.cache[key] = pts
	c.mu.Unlock()
	return pts, nil
}
