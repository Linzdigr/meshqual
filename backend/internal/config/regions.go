package config

import (
	"fmt"
	"strings"
)

// DefaultRegionNames are the region names tried when none are configured:
// names a French mesh plausibly uses (country, regions, departments, large
// towns), each in the usual spellings. Regions only match by exact name, so
// a mesh with its own names should list them (regionNames or
// MESHQUAL_REGION_NAMES).
func DefaultRegionNames() []string {
	words := []string{
		"fr", "france", "eu", "europe", "test", "local",
		"bzh", "breizh", "bretagne", "normandie", "pays-de-la-loire", "pdl",
		"idf", "ile-de-france", "occitanie", "nouvelle-aquitaine", "auvergne-rhone-alpes",
		"aura", "grand-est", "hauts-de-france", "paca", "centre-val-de-loire",
		"bourgogne-franche-comte", "corse",
		"ille-et-vilaine", "morbihan", "finistere", "cotes-d-armor", "loire-atlantique",
		"manche", "mayenne", "calvados",
		// ISO-like region codes, as in "fr-bre" (seen around Rennes).
		"fr-bre", "fr-nor", "fr-pdl", "fr-idf", "fr-occ", "fr-naq", "fr-ara", "fr-ges",
		"fr-hdf", "fr-pac", "fr-cvl", "fr-bfc", "fr-cor",
		"rennes", "nantes", "brest", "lorient", "vannes", "quimper", "saint-brieuc",
		"saint-malo", "paris", "lyon", "marseille", "toulouse", "bordeaux", "lille",
	}
	var out []string
	for _, w := range words {
		out = append(out, w, strings.ToUpper(w), strings.ToUpper(w[:1])+w[1:])
	}
	depts := []string{"2a", "2b"}
	for i := 1; i <= 95; i++ {
		if i != 20 {
			depts = append(depts, fmt.Sprintf("%02d", i))
		}
	}
	for _, d := range depts {
		u := strings.ToUpper(d)
		out = append(out, d, u, "fr-"+d, "FR-"+u, "fr"+d, "FR"+u, "fr_"+d, "FR_"+u)
	}
	return out
}
