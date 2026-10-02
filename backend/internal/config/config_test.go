package config

import (
	"os"
	"path/filepath"
	"testing"
)

func writeConfig(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestSourceEnabled(t *testing.T) {
	p := writeConfig(t, `{"sources": [
		{"id": "comchan", "brokerUrl": "mqtts://a:8883"},
		{"id": "local", "brokerUrl": "mqtt://b:1884", "enabled": false}
	]}`)

	cfg, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.Sources[0].IsEnabled() {
		t.Error("a source without \"enabled\" must default to enabled")
	}
	if cfg.Sources[1].IsEnabled() {
		t.Error("\"enabled\": false was ignored")
	}

	t.Setenv("MESHQUAL_MQTT_COMCHAN_ENABLED", "false")
	t.Setenv("MESHQUAL_MQTT_LOCAL_ENABLED", "true")
	cfg, err = Load(p)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Sources[0].IsEnabled() || !cfg.Sources[1].IsEnabled() {
		t.Error("MESHQUAL_MQTT_<ID>_ENABLED did not override the file")
	}

	t.Setenv("MESHQUAL_MQTT_COMCHAN_ENABLED", "nope")
	if _, err := Load(p); err == nil {
		t.Error("a non-boolean ENABLED value must be rejected")
	}
}
