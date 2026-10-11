// Package backend defines the brand-neutral contract between the Sightline Hub and the camera
// systems it wraps (Frigate today; NVR brands and ONVIF cameras later, see todo.go).
//
// The Hub's HTTP API (docs/HUB_API.md) only ever talks to this interface, so nothing above a
// backend knows which brand it is serving. Camera IDs here are the backend's native IDs; the
// Hub maps them to its own public IDs.
package backend

import (
	"context"
	"errors"
	"net/http"
)

var (
	// ErrUnsupported means the system can't do this (the Hub answers 501).
	ErrUnsupported = errors.New("not supported by this system")
	// ErrNotFound means the camera, event or recording doesn't exist (the Hub answers 404).
	ErrNotFound = errors.New("not found")
)

// Camera is one camera as the system reports it.
type Camera struct {
	ID      string
	Name    string
	Enabled bool
	PTZ     bool
	// Aspect is width/height (16/9 when unknown).
	Aspect  float64
	Zones   []string
	Objects []string
	// Detection resolution in pixels, used to normalize object positions (0 when unknown).
	DetectWidth, DetectHeight int
}

// LiveKind says how the Hub reaches a camera's live video.
type LiveKind string

const (
	// LiveRTSP is an RTSP URL; the Hub restreams it to MSE with go2rtc's packages.
	LiveRTSP LiveKind = "rtsp"
	// LiveMSE is an upstream WebSocket that already speaks go2rtc's MSE protocol; the Hub
	// pipes it through unchanged.
	LiveMSE LiveKind = "mse-ws"
)

type LiveSource struct {
	Kind LiveKind
	URL  string
}

// Event is a normalized detection/review item.
type Event struct {
	ID        string
	Camera    string
	Start     float64 // unix seconds
	End       *float64
	Severity  string // "alert" | "detection"
	Objects   []string
	SubLabels []string // recognized names (faces, known plates)
	Zones     []string
	// Detections are the underlying tracked-object IDs (used to match object positions).
	Detections []string
	Reviewed   bool
}

type EventQuery struct {
	Cameras  []string // native IDs; empty = all
	After    float64
	Before   float64
	Severity string
	Limit    int
}

type Segment struct {
	Start float64 `json:"start"`
	End   float64 `json:"end"`
}

type Storage struct {
	Path    string
	UsedPct int
	FreeGB  float64
}

type Health struct {
	// Offline lists enabled cameras that are receiving no video.
	Offline []string
	Storage []Storage
}

type PTZInfo struct {
	CanMove bool     `json:"canMove"`
	CanZoom bool     `json:"canZoom"`
	Presets []string `json:"presets"`
}

// Sink receives a backend's real-time event stream (for Instant Alerts).
type Sink interface {
	// OnEvent is called for new and updated events.
	OnEvent(e Event)
	// OnPosition reports where a tracked object's feet were, in detect-resolution pixels.
	OnPosition(objectID string, x, y float64)
}

// Backend is one wrapped system. Methods return ErrUnsupported for features the system lacks.
type Backend interface {
	ID() string
	// Kind is the system type ("frigate", later "hikvision", "onvif", …).
	Kind() string
	// Label is a plain-language name for the setup page and notifications ("Frigate").
	Label() string

	Cameras(ctx context.Context) ([]Camera, error)
	Snapshot(ctx context.Context, camera string, height int) (body []byte, contentType string, err error)
	Live(ctx context.Context, camera, quality string) (LiveSource, error)

	Events(ctx context.Context, q EventQuery) ([]Event, error)
	Event(ctx context.Context, id string) (Event, error)
	EventThumbnail(ctx context.Context, id string) (body []byte, contentType string, err error)

	Segments(ctx context.Context, camera string, after, before float64) ([]Segment, error)
	// VOD fetches an HLS playlist or media file for a recording window. file is "" for the
	// master playlist, otherwise a path relative to it (as found in a playlist). The Hub
	// rewrites playlist URIs so every follow-up request comes back through it.
	VOD(ctx context.Context, camera string, start, end int64, file string, hdr http.Header) (*http.Response, error)
	// Clip returns an MP4 of the window. hdr carries Range etc.
	Clip(ctx context.Context, camera string, start, end int64, hdr http.Header) (*http.Response, error)

	PTZInfo(ctx context.Context, camera string) (PTZInfo, error)
	// PTZ actions: MOVE_UP|MOVE_DOWN|MOVE_LEFT|MOVE_RIGHT|ZOOM_IN|ZOOM_OUT|STOP|preset_<name>.
	PTZ(ctx context.Context, camera, action string) error

	Health(ctx context.Context) (Health, error)

	// Watch streams real-time events to sink until ctx ends. Backends without an event
	// stream return ErrUnsupported immediately.
	Watch(ctx context.Context, sink Sink) error
}

// Config is how a backend is configured (from the environment, the HA add-on options, or the
// setup page). Kind-specific settings live in the generic fields.
type Config struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
	// Name shown on the setup page; defaults to the kind's label.
	Name string `json:"name,omitempty"`
	// URL is the system's API address (for Frigate, its internal unauthenticated port 5000).
	URL      string `json:"url"`
	Username string `json:"username,omitempty"`
	Password string `json:"password,omitempty"`
	// Event stream (Frigate: MQTT).
	MQTTURL      string `json:"mqttUrl,omitempty"`
	MQTTUser     string `json:"mqttUser,omitempty"`
	MQTTPassword string `json:"mqttPassword,omitempty"`
	TopicPrefix  string `json:"topicPrefix,omitempty"`
	// FromEnv marks the system configured by the container/add-on (not removable on the page).
	FromEnv bool `json:"-"`
}
