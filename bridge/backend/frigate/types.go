package frigate

import (
	"bytes"
	"encoding/json"
	"sort"
	"strings"

	"github.com/zachadams/sightline/bridge/backend"
)

// Wire formats from Frigate (see docs/FRIGATE_API.md).

type ReviewData struct {
	Objects    []string `json:"objects"`
	SubLabels  []string `json:"sub_labels"`
	Zones      []string `json:"zones"`
	Detections []string `json:"detections"`
}

// Review is one item from /api/review and the frigate/reviews MQTT topic.
type Review struct {
	ID              string     `json:"id"`
	Camera          string     `json:"camera"`
	StartTime       float64    `json:"start_time"`
	EndTime         *float64   `json:"end_time,omitempty"`
	Severity        string     `json:"severity"`
	ThumbPath       string     `json:"thumb_path,omitempty"`
	HasBeenReviewed bool       `json:"has_been_reviewed,omitempty"`
	Data            ReviewData `json:"data"`
}

// ReviewMessage is a frigate/reviews MQTT message.
type ReviewMessage struct {
	Type   string `json:"type"`
	Before Review `json:"before"`
	After  Review `json:"after"`
}

// ObjectMessage is a frigate/events MQTT message (box in detect pixels: x1, y1, x2, y2).
type ObjectMessage struct {
	Type  string `json:"type"`
	After struct {
		ID     string    `json:"id"`
		Camera string    `json:"camera"`
		Box    []float64 `json:"box"`
	} `json:"after"`
}

// Event converts a review into the brand-neutral event.
func (r Review) Event() backend.Event {
	subs := make([]string, 0, len(r.Data.SubLabels))
	for _, s := range r.Data.SubLabels {
		if s != "" {
			subs = append(subs, s)
		}
	}
	return backend.Event{
		ID: r.ID, Camera: r.Camera, Start: r.StartTime, End: r.EndTime, Severity: r.Severity,
		Objects: r.Data.Objects, SubLabels: subs, Zones: r.Data.Zones, Detections: r.Data.Detections,
		Reviewed: r.HasBeenReviewed,
	}
}

// ParseReviewMessage decodes a frigate/reviews payload. ok is false for malformed messages and
// for types that never alert ("end").
func ParseReviewMessage(payload []byte) (m ReviewMessage, ok bool, err error) {
	if err := json.Unmarshal(payload, &m); err != nil {
		return m, false, err
	}
	// "new" covers most cases; "update" catches detection→alert upgrades and new objects.
	return m, m.Type == "new" || m.Type == "update", nil
}

// ParseObjectMessage returns the object's foot position (bottom-center of its box).
func ParseObjectMessage(payload []byte) (id string, x, y float64, ok bool) {
	var m ObjectMessage
	if json.Unmarshal(payload, &m) != nil || len(m.After.Box) != 4 {
		return "", 0, 0, false
	}
	b := m.After.Box
	return m.After.ID, (b[0] + b[2]) / 2, b[3], true
}

// Stats is the subset of /api/stats the Hub uses.
type Stats struct {
	Cameras map[string]struct {
		CameraFPS float64 `json:"camera_fps"`
	} `json:"cameras"`
	Service struct {
		Storage map[string]struct {
			Total float64 `json:"total"` // MB
			Used  float64 `json:"used"`
			Free  float64 `json:"free"`
		} `json:"storage"`
	} `json:"service"`
}

type CameraConfig struct {
	Enabled      *bool  `json:"enabled"`
	FriendlyName string `json:"friendly_name"`
	UI           struct {
		Order int `json:"order"`
	} `json:"ui"`
	Zones   map[string]json.RawMessage `json:"zones"`
	Objects struct {
		Track []string `json:"track"`
	} `json:"objects"`
	ONVIF struct {
		Host string `json:"host"`
	} `json:"onvif"`
	Detect struct {
		Width  int `json:"width"`
		Height int `json:"height"`
	} `json:"detect"`
	Live struct {
		Streams OrderedStreams `json:"streams"`
	} `json:"live"`
}

// Config is the subset of /api/config the Hub uses.
type Config struct {
	Cameras map[string]CameraConfig `json:"cameras"`
	// Go2RTC is Frigate's built-in go2rtc: its streams are also served over RTSP (port 8554),
	// with the ONVIF backchannel when the camera behind them has a speaker.
	Go2RTC struct {
		Streams map[string]json.RawMessage `json:"streams"`
		RTSP    struct {
			Username string `json:"username"`
			Password string `json:"password"`
		} `json:"rtsp"`
	} `json:"go2rtc"`
}

// HealthFrom turns one stats/config poll into the brand-neutral health report.
func HealthFrom(stats Stats, cfg Config) backend.Health {
	var h backend.Health
	names := make([]string, 0, len(stats.Cameras))
	for name := range stats.Cameras {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		c := cfg.Cameras[name]
		if c.Enabled != nil && !*c.Enabled {
			continue
		}
		if stats.Cameras[name].CameraFPS == 0 {
			h.Offline = append(h.Offline, name)
		}
	}
	paths := make([]string, 0, len(stats.Service.Storage))
	for p := range stats.Service.Storage {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	for _, path := range paths {
		s := stats.Service.Storage[path]
		if s.Total <= 0 || !strings.HasPrefix(path, "/media/frigate") {
			continue
		}
		h.Storage = append(h.Storage, backend.Storage{Path: path, UsedPct: int(s.Used / s.Total * 100), FreeGB: s.Free / 1024})
	}
	return h
}

// OrderedStreams keeps live.streams in config order (the first entry is the main stream).
type OrderedStreams []struct{ Label, Name string }

func (o *OrderedStreams) UnmarshalJSON(b []byte) error {
	*o = nil
	dec := json.NewDecoder(bytes.NewReader(b))
	t, err := dec.Token()
	if err != nil || t == nil {
		return err
	}
	if d, ok := t.(json.Delim); !ok || d != '{' {
		return nil
	}
	for dec.More() {
		k, err := dec.Token()
		if err != nil {
			return err
		}
		var v string
		if err := dec.Decode(&v); err != nil {
			return err
		}
		label, _ := k.(string)
		*o = append(*o, struct{ Label, Name string }{label, v})
	}
	return nil
}

func titleCase(id string) string {
	words := strings.Fields(strings.NewReplacer("_", " ", "-", " ").Replace(id))
	for i, w := range words {
		words[i] = strings.ToUpper(w[:1]) + w[1:]
	}
	return strings.Join(words, " ")
}
