// Package config loads service configuration from a JSON file and the environment.
package config

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/yvanferez/meshqual/backend/internal/source"
)

// Config is the whole service configuration.
type Config struct {
	Addr string `json:"addr"`
	DSN  string `json:"dsn"`

	// Sources is the list of brokers to ingest from. Two are wired by default:
	// the public community broker and a self-hosted one.
	Sources []source.MQTTConfig `json:"sources"`

	// ReplayFile, when set, adds an NDJSON replay source. Useful with no broker.
	ReplayFile  string  `json:"replayFile"`
	ReplaySpeed float64 `json:"replaySpeed"`
	ReplayLoop  bool    `json:"replayLoop"`

	// LiveWindow is how long a link stays on the map after its last sample.
	LiveWindow Duration `json:"liveWindow"`
	// NodeMaxAge hides from the map nodes not heard for this long. They stay
	// known to the resolver, which still needs them to read paths. 0 disables.
	NodeMaxAge Duration `json:"nodeMaxAge"`
	// FramesPerLink is how many recent frames the detail panel can show.
	FramesPerLink int `json:"framesPerLink"`
	// SNRSamplesPerLink bounds the sample ring the exact percentiles come from.
	SNRSamplesPerLink int `json:"snrSamplesPerLink"`

	// MinDirectionSamples is how many SNR values a direction needs to count
	// towards the link quality (the weaker direction's median).
	MinDirectionSamples int `json:"minDirectionSamples"`
	// AsymmetryThresholdDb is the gap between direction medians from which the
	// map's asymmetry view highlights a link.
	AsymmetryThresholdDb float64 `json:"asymmetryThresholdDb"`

	// MaxHopKm is the longest distance accepted for a single radio hop. Longer
	// pairs come from path hashes colliding across distant meshes. 0 disables it.
	MaxHopKm float64 `json:"maxHopKm"`

	// PushInterval coalesces live updates. Below about a second the browser
	// spends more time re-styling the map than the data changes.
	PushInterval Duration `json:"pushInterval"`
	// FlushInterval and FlushSize bound the database write batches.
	FlushInterval Duration `json:"flushInterval"`
	FlushSize     int      `json:"flushSize"`

	// PersistObservations archives every raw frame. Off keeps the database small;
	// on lets links be re-derived later after a resolver improvement.
	PersistObservations bool `json:"persistObservations"`

	CORSOrigins []string `json:"corsOrigins"`
	LogLevel    string   `json:"logLevel"`
}

// Duration is a time.Duration that unmarshals from "10s".
type Duration time.Duration

func (d *Duration) UnmarshalJSON(b []byte) error {
	s := strings.Trim(string(b), `"`)
	if s == "" || s == "null" {
		return nil
	}
	if n, err := strconv.Atoi(s); err == nil {
		*d = Duration(time.Duration(n) * time.Second)
		return nil
	}
	v, err := time.ParseDuration(s)
	if err != nil {
		return err
	}
	*d = Duration(v)
	return nil
}

// D returns the underlying duration.
func (d Duration) D() time.Duration { return time.Duration(d) }

// Default returns a configuration that boots with no database and no broker.
func Default() Config {
	return Config{
		Addr:                 ":8080",
		LiveWindow:           Duration(24 * time.Hour),
		NodeMaxAge:           Duration(48 * time.Hour),
		FramesPerLink:        20,
		SNRSamplesPerLink:    256,
		MaxHopKm:             300,
		MinDirectionSamples:  3,
		AsymmetryThresholdDb: 6,
		PushInterval:         Duration(2 * time.Second),
		FlushInterval:        Duration(2 * time.Second),
		FlushSize:            500,
		PersistObservations:  true,
		LogLevel:             "info",
	}
}

// Load reads path (optional) then applies environment overrides.
func Load(path string) (Config, error) {
	cfg := Default()
	if path != "" {
		body, err := os.ReadFile(path)
		if err != nil {
			return cfg, fmt.Errorf("config: %w", err)
		}
		if err := json.Unmarshal(body, &cfg); err != nil {
			return cfg, fmt.Errorf("config: %s: %w", path, err)
		}
	}
	if err := cfg.applyEnv(); err != nil {
		return cfg, err
	}
	return cfg, cfg.validate()
}

func (c *Config) applyEnv() error {
	if v := os.Getenv("MESHQUAL_ADDR"); v != "" {
		c.Addr = v
	}
	if v := os.Getenv("MESHQUAL_DSN"); v != "" {
		c.DSN = v
	}
	if v := os.Getenv("MESHQUAL_LOG_LEVEL"); v != "" {
		c.LogLevel = v
	}
	if v := os.Getenv("MESHQUAL_REPLAY_FILE"); v != "" {
		c.ReplayFile = v
	}
	if v := os.Getenv("MESHQUAL_CORS_ORIGINS"); v != "" {
		c.CORSOrigins = splitAndTrim(v)
	}
	// Credentials belong in the environment, not in a file that ends up in git.
	for i := range c.Sources {
		id := strings.ToUpper(strings.NewReplacer("-", "_", ".", "_").Replace(c.Sources[i].ID))
		if v := os.Getenv("MESHQUAL_MQTT_" + id + "_USERNAME"); v != "" {
			c.Sources[i].Username = v
		}
		if v := os.Getenv("MESHQUAL_MQTT_" + id + "_PASSWORD"); v != "" {
			c.Sources[i].Password = v
		}
		if v := os.Getenv("MESHQUAL_MQTT_" + id + "_URL"); v != "" {
			c.Sources[i].BrokerURL = v
		}
		if v := os.Getenv("MESHQUAL_MQTT_" + id + "_ENABLED"); v != "" {
			on, err := strconv.ParseBool(v)
			if err != nil {
				return fmt.Errorf("config: MESHQUAL_MQTT_%s_ENABLED=%q is not a boolean", id, v)
			}
			c.Sources[i].Enabled = &on
		}
	}
	return nil
}

func (c *Config) validate() error {
	seen := map[string]bool{}
	for _, s := range c.Sources {
		if s.ID == "" {
			return fmt.Errorf("config: every source needs an id")
		}
		if seen[s.ID] {
			return fmt.Errorf("config: duplicate source id %q", s.ID)
		}
		seen[s.ID] = true
	}
	if c.PushInterval.D() < 250*time.Millisecond {
		return fmt.Errorf("config: pushInterval %s is below the 250ms floor", c.PushInterval.D())
	}
	return nil
}

func splitAndTrim(s string) []string {
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
