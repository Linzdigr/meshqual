package api

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func (f *fixture) post(t *testing.T, url, token, body string) (*http.Response, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, url, strings.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	f.srv.ServeHTTP(rec, req)
	res := rec.Result()
	raw, _ := io.ReadAll(res.Body)
	out := map[string]any{}
	_ = json.Unmarshal(raw, &out)
	return res, out
}

func TestCompanionMeasurements(t *testing.T) {
	f := newFixture(t)
	trace := func(tag int, hops ...[3]any) string {
		var hs []string
		for _, h := range hops {
			hs = append(hs, `{"from":"`+h[0].(string)+`","to":"`+h[1].(string)+`","snr":`+h[2].(string)+`}`)
		}
		return `{"companion":"` + f.obs + `","source":"trace","tag":` + itoa(tag) +
			`,"at":"` + time.Now().UTC().Format(time.RFC3339) + `","hops":[` + strings.Join(hs, ",") + `]}`
	}
	body := trace(7, [3]any{f.a, f.b, "4.25"}, [3]any{f.b, f.a, "-2.5"})

	if res, _ := f.post(t, "/api/measurements", "", body); res.StatusCode != http.StatusNotFound {
		t.Errorf("without a server token: status %d, want 404", res.StatusCode)
	}
	f.srv.d.SubmitToken = "s3cret"
	if res, _ := f.post(t, "/api/measurements", "wrong", body); res.StatusCode != http.StatusUnauthorized {
		t.Errorf("bad token: status %d, want 401", res.StatusCode)
	}

	res, out := f.post(t, "/api/measurements", "s3cret", body)
	if res.StatusCode != http.StatusOK || out["accepted"] != float64(2) {
		t.Fatalf("status %d, %v; want both hops accepted", res.StatusCode, out)
	}
	_, raw := f.get(t, "/api/links?minLng=-180&minLat=-85&maxLng=180&maxLat=85")
	var fc FeatureCollection
	if err := json.Unmarshal(raw, &fc); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, ft := range fc.Features {
		p := ft.Properties
		if ft.ID == f.a+":"+f.b || ft.ID == f.b+":"+f.a {
			found = true
			if p["kind"] != "trace" || p["snrBasis"] != "few" {
				t.Errorf("link = kind %v basis %v, want a trace measured both ways", p["kind"], p["snrBasis"])
			}
		}
	}
	if !found {
		t.Error("the measured link is not on the map")
	}

	// The same trace again (the browser retrying) counts nothing twice.
	if _, out = f.post(t, "/api/measurements", "s3cret", body); out["accepted"] != float64(0) {
		t.Errorf("resubmission accepted %v, want 0", out["accepted"])
	}
	// A hop to a node the server does not know is skipped, not stored.
	unknown := strings.Repeat("AB", 32)
	_, out = f.post(t, "/api/measurements", "s3cret", trace(8, [3]any{f.a, unknown, "1"}))
	if out["accepted"] != float64(0) || out["skipped"].(map[string]any)["unknown"] != float64(1) {
		t.Errorf("unknown node: %v", out)
	}
}

func itoa(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}
