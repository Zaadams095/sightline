package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/zachadams/sightline/bridge/backend"
)

// Recording playback for every kind of recorder (docs/HUB_API.md "playback"):
//
//	GET /v1/recordings/{cam}/playback?start=&end=   → JSON saying how to play the window
//	GET /v1/recordings/{cam}/playback/stream?…      → WebSocket (MSE), an RTSP replay restreamed
//	GET /v1/recordings/{cam}/playback/file.mp4?…    → the recorder's MP4, proxied with Range
//
// Backends with HLS VOD (Frigate) answer "vod" and the app uses vod.m3u8 as before. Backends
// implementing backend.Player answer "stream". The grant is enforced exactly like vod.m3u8 and
// clip.mp4: the JSON route clamps a partly-outside window, the media routes must be entirely
// inside it, replays are cut off at the window's end, and files are only handed to
// time-limited guests when they're known to lie inside the window.

type playbackSourceView struct {
	// Kind is "mse" (WebSocket speaking the live view's MSE protocol) or "file" (MP4).
	Kind string `json:"kind"`
	URL  string `json:"url"`
	// StartTime (files) is when the file begins, unix seconds; absent = the window start.
	StartTime *float64 `json:"startTime,omitempty"`
}

type playbackView struct {
	// Kind is "vod" (seekable HLS at URL) or "stream" (plays forward from Source).
	Kind   string              `json:"kind"`
	URL    string              `json:"url,omitempty"`
	Source *playbackSourceView `json:"source,omitempty"`
	// Start and End are the window actually granted (clamped to the caller's access).
	Start int64 `json:"start"`
	End   int64 `json:"end"`
	// StartTime (mse streams) is when the first frame really is, when not Start.
	StartTime *float64 `json:"startTime,omitempty"`
}

const playbackCacheTTL = 2 * time.Minute

type playbackEntry struct {
	pb backend.Playback
	at time.Time
}

// playbackCache remembers a backend's answer briefly: the JSON route, then the player's
// WebSocket or byte-range requests, all ask for the same window.
type playbackCache struct {
	mu sync.Mutex
	m  map[string]playbackEntry
}

func (c *playbackCache) get(ctx context.Context, p backend.Player, key, cam string, start, end int64) (backend.Playback, error) {
	now := time.Now()
	c.mu.Lock()
	if e, ok := c.m[key]; ok && now.Sub(e.at) < playbackCacheTTL {
		c.mu.Unlock()
		return e.pb, nil
	}
	c.mu.Unlock()
	pb, err := p.Playback(ctx, cam, float64(start), float64(end))
	if err != nil {
		return pb, err
	}
	if (pb.Live == nil) == (pb.File == nil) {
		return pb, errors.New("the recorder didn't return a recording to play")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.m == nil {
		c.m = map[string]playbackEntry{}
	}
	for k, e := range c.m {
		if now.Sub(e.at) >= playbackCacheTTL {
			delete(c.m, k)
		}
	}
	c.m[key] = playbackEntry{pb: pb, at: now}
	return pb, nil
}

func (h *hub) playbackFor(ctx context.Context, s *system, native string, start, end int64) (backend.Playback, bool, error) {
	p, ok := s.b.(backend.Player)
	if !ok {
		return backend.Playback{}, false, nil
	}
	key := fmt.Sprintf("%s|%s|%d|%d", s.cfg.ID, native, start, end)
	pb, err := h.playbacks.get(ctx, p, key, native, start, end)
	if errors.Is(err, backend.ErrUnsupported) {
		return pb, false, nil
	}
	return pb, true, err
}

// liveAllowed: a replay may start later than asked (nearest clip), but never outside the window.
func liveAllowed(g *grant, pb backend.Playback, end int64) bool {
	if g.Recordings.Mode == "all" || pb.StartTime == 0 {
		return true
	}
	return inWindow(g, pb.StartTime) && pb.StartTime < float64(end)
}

// fileAllowed: a whole file may reach outside the window, so time-limited guests only get
// files known to lie inside it.
func fileAllowed(g *grant, pb backend.Playback, start int64) bool {
	if g.Recordings.Mode == "all" {
		return true
	}
	first := pb.StartTime
	if first == 0 {
		first = float64(start)
	}
	return pb.EndTime > 0 && inWindow(g, first) && inWindow(g, pb.EndTime)
}

func floatPtr(f float64) *float64 {
	if f == 0 {
		return nil
	}
	return &f
}

func forbiddenWindow(w http.ResponseWriter) {
	apiError(w, http.StatusForbidden, "outside_window", "This is outside the time you were given access to.")
}

func (h *hub) handlePlayback(w http.ResponseWriter, r *http.Request) {
	cam := r.PathValue("cam")
	s, native, ok := h.camera(w, r, cam)
	if !ok {
		return
	}
	g := grantFrom(r)
	q := r.URL.Query()
	start, end, ok := mediaWindow(w, g, q.Get("start"), q.Get("end"), false)
	if !ok {
		return
	}
	base := "/v1/recordings/" + url.PathEscape(cam)
	win := "?start=" + strconv.FormatInt(start, 10) + "&end=" + strconv.FormatInt(end, 10)
	if tq := tokenQuery(r); tq != "" {
		win += "&" + strings.TrimPrefix(tq, "?")
	}
	out := playbackView{Kind: "vod", URL: base + "/vod.m3u8" + win, Start: start, End: end}

	pb, isPlayer, err := h.playbackFor(r.Context(), s, native, start, end)
	switch {
	case err != nil:
		backendError(w, err)
		return
	case !isPlayer && !s.b.Capabilities().Recordings:
		backendError(w, backend.ErrUnsupported)
		return
	case !isPlayer:
		// HLS VOD (Frigate): unchanged.
	case pb.Live != nil:
		if !liveAllowed(g, pb, end) {
			forbiddenWindow(w)
			return
		}
		out = playbackView{Kind: "stream", Start: start, End: end, StartTime: floatPtr(pb.StartTime),
			Source: &playbackSourceView{Kind: "mse", URL: base + "/playback/stream" + win}}
	case fileAllowed(g, pb, start):
		out = playbackView{Kind: "stream", Start: start, End: end,
			Source: &playbackSourceView{Kind: "file", URL: base + "/playback/file.mp4" + win, StartTime: floatPtr(pb.StartTime)}}
	case s.b.Capabilities().Clips:
		// The recorder's file reaches outside this guest's window: export exactly the window.
		out = playbackView{Kind: "stream", Start: start, End: end,
			Source: &playbackSourceView{Kind: "file", URL: base + "/clip.mp4" + win}}
	default:
		forbiddenWindow(w)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// playbackMedia resolves a follow-up request: the window must be entirely inside the grant
// (it is when the URL came from handlePlayback).
func (h *hub) playbackMedia(w http.ResponseWriter, r *http.Request) (*system, backend.Playback, int64, int64, bool) {
	s, native, ok := h.camera(w, r, r.PathValue("cam"))
	if !ok {
		return nil, backend.Playback{}, 0, 0, false
	}
	q := r.URL.Query()
	start, end, ok := mediaWindow(w, grantFrom(r), q.Get("start"), q.Get("end"), true)
	if !ok {
		return nil, backend.Playback{}, 0, 0, false
	}
	if e, _ := strconv.ParseInt(q.Get("end"), 10, 64); e != end {
		forbiddenWindow(w) // windows are always issued within the 2 h cap
		return nil, backend.Playback{}, 0, 0, false
	}
	pb, isPlayer, err := h.playbackFor(r.Context(), s, native, start, end)
	if err == nil && !isPlayer {
		err = backend.ErrUnsupported
	}
	if err != nil {
		backendError(w, err)
		return nil, backend.Playback{}, 0, 0, false
	}
	return s, pb, start, end, true
}

func (h *hub) handlePlaybackStream(w http.ResponseWriter, r *http.Request) {
	_, pb, start, end, ok := h.playbackMedia(w, r)
	if !ok {
		return
	}
	if pb.Live == nil {
		backendError(w, backend.ErrNotFound)
		return
	}
	if !liveAllowed(grantFrom(r), pb, end) {
		forbiddenWindow(w)
		return
	}
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer ws.Close()
	// The replay plays in real time; stop it at the window's end so it can't run past the
	// caller's access even if the recorder ignores the end time.
	first := max(float64(start), pb.StartTime)
	limit := time.Duration((float64(end)-first)*float64(time.Second)) + replaySlack
	stop := time.AfterFunc(max(limit, replaySlack), func() { ws.Close() })
	defer stop.Stop()
	switch pb.Live.Kind {
	case backend.LiveMSE:
		pipeMSE(r.Context(), ws, pb.Live.URL)
	case backend.LiveRTSP:
		serveRTSP(ws, pb.Live.URL)
	default:
		_ = ws.WriteJSON(wsMessage{Type: "error", Value: "unsupported recording source"})
	}
}

// replaySlack allows for connection setup before the first frame.
var replaySlack = 5 * time.Second

func (h *hub) handlePlaybackFile(w http.ResponseWriter, r *http.Request) {
	_, pb, start, _, ok := h.playbackMedia(w, r)
	if !ok {
		return
	}
	if pb.File == nil {
		backendError(w, backend.ErrNotFound)
		return
	}
	if !fileAllowed(grantFrom(r), pb, start) {
		forbiddenWindow(w)
		return
	}
	resp, err := pb.File(r.Context(), r.Header)
	if err != nil {
		backendError(w, err)
		return
	}
	h.proxyMedia(w, resp, "", "")
}
