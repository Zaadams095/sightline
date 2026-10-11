package main

import (
	"context"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/zachadams/sightline/bridge/backend"
	"github.com/zachadams/sightline/bridge/backend/talk"
)

// Two-way audio and deterrence (docs/HUB_API.md "Talk" and "Deterrence").
//
// GET /v1/cameras/{id}/talk without a WebSocket upgrade answers whether the camera can take
// the caller's voice ({"available":bool,"codec":"PCMU/8000"}); the app shows its Talk button
// only then. With an upgrade it is the talk session: binary frames of 16-bit little-endian
// mono PCM at 8 kHz from the app, {"type":"talk","value":codec} once the speaker is open, or
// {"type":"error","value":reason}. The phone's tunnel library speaks the same protocol to
// cameras it reaches itself (tunnel/wgtunnel/talk.go).

const (
	talkProbeTimeout = 6 * time.Second
	// A camera's speaker doesn't come and go; a "no" is retried sooner in case it was offline.
	talkYesTTL = 30 * time.Minute
	talkNoTTL  = 2 * time.Minute
)

type talkProbe struct {
	codec string
	at    time.Time
}

// talkProbeCache remembers which cameras have a usable speaker.
type talkProbeCache struct {
	mu sync.Mutex
	m  map[string]talkProbe
}

func (c *talkProbeCache) get(key string, target backend.TalkTarget) string {
	c.mu.Lock()
	e, ok := c.m[key]
	c.mu.Unlock()
	if ok {
		ttl := talkNoTTL
		if e.codec != "" {
			ttl = talkYesTTL
		}
		if time.Since(e.at) < ttl {
			return e.codec
		}
	}
	codec := ""
	if cd, err := talk.Probe(target.Kind, target.URL, talkProbeTimeout); err == nil {
		codec = cd.String()
	}
	c.mu.Lock()
	if c.m == nil {
		c.m = map[string]talkProbe{}
	}
	c.m[key] = talkProbe{codec: codec, at: time.Now()}
	c.mu.Unlock()
	return codec
}

// talkUpgrader: tokens, not cookies, authenticate (as for live view), so any origin is fine.
var talkUpgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 1024,
	CheckOrigin:     func(*http.Request) bool { return true },
}

func (h *hub) talkTarget(w http.ResponseWriter, r *http.Request) (backend.TalkTarget, string, bool) {
	id := r.PathValue("id")
	s, native, ok := h.camera(w, r, id)
	if !ok {
		return backend.TalkTarget{}, "", false
	}
	t, ok := s.b.(backend.Talker)
	if !ok || !s.b.Capabilities().Talk {
		backendError(w, backend.ErrUnsupported)
		return backend.TalkTarget{}, "", false
	}
	target, err := t.Talk(r.Context(), native)
	if err != nil {
		backendError(w, err)
		return backend.TalkTarget{}, "", false
	}
	return target, s.cfg.ID + "/" + native, true
}

func (h *hub) handleTalk(w http.ResponseWriter, r *http.Request) {
	target, key, ok := h.talkTarget(w, r)
	if !ok {
		return
	}
	if !websocket.IsWebSocketUpgrade(r) {
		codec := h.talks.get(key, target)
		writeJSON(w, http.StatusOK, map[string]any{"available": codec != "", "codec": codec})
		return
	}
	ws, err := talkUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer ws.Close()
	ws.SetReadLimit(32 << 10)
	serveTalk(ws, target)
}

// serveTalk opens the camera's speaker and feeds it the app's audio until either side hangs up.
func serveTalk(ws *websocket.Conn, target backend.TalkTarget) {
	sess, err := talk.Open(target.Kind, target.URL)
	if err != nil {
		_ = ws.WriteJSON(wsMessage{Type: "error", Value: talk.FriendlyError(err)})
		return
	}
	defer sess.Close()
	if err := ws.WriteJSON(wsMessage{Type: "talk", Value: sess.Codec.String()}); err != nil {
		return
	}
	go func() {
		<-sess.Done()
		ws.Close()
	}()
	for {
		mt, b, err := ws.ReadMessage()
		if err != nil {
			return
		}
		if mt == websocket.BinaryMessage {
			sess.Write(b)
		}
	}
}

func (h *hub) deterrer(w http.ResponseWriter, r *http.Request) (backend.Deterrer, string, bool) {
	s, native, ok := h.camera(w, r, r.PathValue("id"))
	if !ok {
		return nil, "", false
	}
	d, ok := s.b.(backend.Deterrer)
	if !ok || !s.b.Capabilities().Deter {
		backendError(w, backend.ErrUnsupported)
		return nil, "", false
	}
	return d, native, true
}

func (h *hub) handleDeterInfo(w http.ResponseWriter, r *http.Request) {
	d, native, ok := h.deterrer(w, r)
	if !ok {
		return
	}
	info, err := d.DeterInfo(r.Context(), native)
	if err != nil {
		backendError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, info)
}

func (h *hub) handleDeter(w http.ResponseWriter, r *http.Request) {
	d, native, ok := h.deterrer(w, r)
	if !ok {
		return
	}
	var body struct {
		Action string `json:"action"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	switch body.Action {
	case backend.DeterLightOn, backend.DeterLightOff, backend.DeterSiren:
	default:
		apiError(w, http.StatusBadRequest, "bad_request", "Unknown action.")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	if err := d.Deter(ctx, native, body.Action); err != nil {
		backendError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
