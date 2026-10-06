// Package los checks the radio line of sight between two sites over a terrain
// profile: the straight line between the antennas, the earth's curvature and
// the first Fresnel zone. It sees bare ground only: buildings and trees are not
// in the elevation model, so a "clear" verdict is an upper bound.
package los

import "math"

const (
	earthRadiusM = 6_371_000.0
	speedOfLight = 299_792_458.0
	// ClearRatio is the share of the first Fresnel zone that must stay free
	// for a link to count as clear: the usual 60% rule.
	ClearRatio = 0.6
)

// Params are the assumptions behind a verdict.
type Params struct {
	FreqMHz float64 // carrier frequency
	// AntennaM is the antenna height above ground at both ends. Unknown in
	// practice, so it is one assumption for every node.
	AntennaM float64
	// K is the effective earth radius factor (4/3 for a standard atmosphere).
	K float64
}

// Point is one ground sample along the path.
type Point struct {
	DistM   float64 // from the first end
	GroundM float64 // ground elevation
}

// Sample is one point of the analysed profile, ready to draw.
type Sample struct {
	DistKm float64 `json:"d"`
	// TerrainM is the ground plus the earth's bulge at that point: what the
	// radio path actually has to clear.
	TerrainM float64 `json:"t"`
	LosM     float64 `json:"l"` // height of the straight antenna-to-antenna line
	FresnelM float64 `json:"f"` // first Fresnel zone radius
}

// Verdict names how clear the path is.
type Verdict string

const (
	Clear   Verdict = "clear"   // at least ClearRatio of the Fresnel zone free
	Partial Verdict = "partial" // line of sight, but the Fresnel zone is encroached
	Blocked Verdict = "blocked" // the terrain crosses the line of sight
)

// Result is the analysis of one path.
type Result struct {
	DistanceKm float64  `json:"distKm"`
	Samples    []Sample `json:"points"`
	// Clearance is the smallest (line - terrain) / Fresnel radius along the
	// path: 1 means the whole first zone is free, 0 grazing, below 0 blocked.
	Clearance float64 `json:"clearance"`
	Verdict   Verdict `json:"verdict"`
	// Worst is the sample where Clearance is reached.
	Worst Sample `json:"worst"`
}

// Analyze computes the line of sight over a profile ordered from one end to
// the other. It needs at least the two end points.
func Analyze(profile []Point, p Params) (Result, bool) {
	n := len(profile)
	if n < 2 || p.FreqMHz <= 0 {
		return Result{}, false
	}
	k := p.K
	if k <= 0 {
		k = 4.0 / 3.0
	}
	total := profile[n-1].DistM
	if total <= 0 {
		return Result{}, false
	}
	lambda := speedOfLight / (p.FreqMHz * 1e6)
	hA := profile[0].GroundM + p.AntennaM
	hB := profile[n-1].GroundM + p.AntennaM

	res := Result{DistanceKm: round(total/1000, 3), Clearance: math.Inf(1)}
	res.Samples = make([]Sample, n)
	for i, pt := range profile {
		d1, d2 := pt.DistM, total-pt.DistM
		bulge := d1 * d2 / (2 * k * earthRadiusM)
		line := hA + (hB-hA)*d1/total
		fresnel := 0.0
		if d1 > 0 && d2 > 0 {
			fresnel = math.Sqrt(lambda * d1 * d2 / total)
		}
		s := Sample{
			DistKm: round(d1/1000, 3), TerrainM: round(pt.GroundM+bulge, 2),
			LosM: round(line, 2), FresnelM: round(fresnel, 2),
		}
		res.Samples[i] = s
		// The ends sit on the antennas themselves: only the path between counts.
		if fresnel > 0 {
			if c := (line - (pt.GroundM + bulge)) / fresnel; c < res.Clearance {
				res.Clearance, res.Worst = c, s
			}
		}
	}
	if math.IsInf(res.Clearance, 1) {
		// Too few samples to see the path between the ends.
		return Result{}, false
	}
	res.Clearance = round(res.Clearance, 2)
	switch {
	case res.Clearance >= ClearRatio:
		res.Verdict = Clear
	case res.Clearance >= 0:
		res.Verdict = Partial
	default:
		res.Verdict = Blocked
	}
	return res, true
}

func round(v float64, places int) float64 {
	p := math.Pow(10, float64(places))
	return math.Round(v*p) / p
}
