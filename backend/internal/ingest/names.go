package ingest

import "github.com/yvanferez/meshqual/backend/internal/meshcore"

func payloadName(t uint8) string { return meshcore.PayloadName(t) }
func routeName(t uint8) string   { return meshcore.RouteName(t) }
