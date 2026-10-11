package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/AlexxIT/go2rtc/pkg/mp4"
	"github.com/gorilla/websocket"

	"github.com/zachadams/sightline/bridge/backend"
)

// Live view as HLS, for players without Media Source Extensions (Apple TV's AVPlayer, which
// has no WebView, and anything else that only speaks HLS):
//
//	GET /v1/cameras/{id}/live.m3u8?quality=   → master playlist; starts a session
//	GET /v1/cameras/{id}/hls/{sid}/playlist.m3u8
//	GET /v1/cameras/{id}/hls/{sid}/init.mp4
//	GET /v1/cameras/{id}/hls/{sid}/s{n}.m4s
//
// Same approach as go2rtc's own HLS (internal/hls): the camera's fMP4 stream (the very bytes
// the MSE WebSocket would carry) is buffered per viewer, and each segment request takes what
// arrived since the last one. The playlist always lists the next two segments, which AVPlayer
// treats as a live stream. Every request is grant-checked like the other camera routes, and
// a session belongs to the grant and camera that started it. Sessions end a few seconds after
// the player stops asking.

const (
	hlsKeepalive   = 10 * time.Second
	hlsStartWait   = 12 * time.Second
	hlsMaxSessions = 16
	// A player that stalls doesn't make the Hub buffer forever.
	hlsMaxBuffer = 16 << 20
	// What AVPlayer can decode: H.264, H.265 and AAC.
	hlsCodecs = "avc1.640029,avc1.64002A,avc1.640033,hvc1.1.6.L153.B0,mp4a.40.2,mp4a.40.5"
)

var errHLSBusy = errors.New("too many live streams are open on the Hub right now")

type hlsSession struct {
	id      string
	grantID string
	camera  string

	mu     sync.Mutex
	init   []byte
	buf    []byte
	seq    int
	codecs string
	err    error
	ready  chan struct{} // closed once the init segment arrived (or the source failed)
	once   sync.Once
	alive  *time.Timer
	cancel context.CancelFunc
}

type hlsSessions struct {
	mu sync.Mutex
	m  map[string]*hlsSession
}

func (s *hlsSession) markReady(err error) {
	s.once.Do(func() {
		if err != nil {
			s.mu.Lock()
			s.err = err
			s.mu.Unlock()
		}
		close(s.ready)
	})
}

// Write receives the fMP4 stream: the first write is the init segment, the rest are fragments.
func (s *hlsSession) Write(p []byte) (int, error) {
	s.mu.Lock()
	if s.init == nil {
		s.init = append([]byte(nil), p...)
		s.mu.Unlock()
		s.markReady(nil)
		return len(p), nil
	}
	if len(s.buf)+len(p) > hlsMaxBuffer {
		s.buf = s.buf[:0]
	}
	s.buf = append(s.buf, p...)
	s.mu.Unlock()
	return len(p), nil
}

// take waits briefly for media and hands back everything buffered so far.
func (s *hlsSession) take(ctx context.Context, initOnly bool) []byte {
	deadline := time.Now().Add(3 * time.Second)
	for {
		s.mu.Lock()
		if s.init != nil && len(s.buf) > 0 {
			var out []byte
			if initOnly {
				out = s.init
			} else {
				out, s.buf = s.buf, nil
				s.seq++
			}
			s.mu.Unlock()
			return out
		}
		failed := s.err != nil
		s.mu.Unlock()
		if failed || time.Now().After(deadline) {
			return nil
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(50 * time.Millisecond):
		}
	}
}

func (s *hlsSession) playlist(q string) string {
	s.mu.Lock()
	seq := s.seq
	s.mu.Unlock()
	return fmt.Sprintf("#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:%d\n"+
		"#EXT-X-MAP:URI=\"init.mp4%s\"\n#EXTINF:0.500,\ns%d.m4s%s\n#EXTINF:0.500,\ns%d.m4s%s\n",
		seq, q, seq, q, seq+1, q)
}

func newSessionID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (hs *hlsSessions) add(s *hlsSession) error {
	hs.mu.Lock()
	defer hs.mu.Unlock()
	if hs.m == nil {
		hs.m = map[string]*hlsSession{}
	}
	if len(hs.m) >= hlsMaxSessions {
		return errHLSBusy
	}
	hs.m[s.id] = s
	s.alive = time.AfterFunc(hlsKeepalive, func() { hs.remove(s.id) })
	return nil
}

func (hs *hlsSessions) get(id string) *hlsSession {
	hs.mu.Lock()
	defer hs.mu.Unlock()
	return hs.m[id]
}

func (hs *hlsSessions) remove(id string) {
	hs.mu.Lock()
	s := hs.m[id]
	delete(hs.m, id)
	hs.mu.Unlock()
	if s != nil {
		s.alive.Stop()
		s.cancel()
	}
}

func (hs *hlsSessions) count() int {
	hs.mu.Lock()
	defer hs.mu.Unlock()
	return len(hs.m)
}

// runHLSSource feeds a session from the backend's live source until ctx ends.
func runHLSSource(ctx context.Context, s *hlsSession, src backend.LiveSource) {
	switch src.Kind {
	case backend.LiveRTSP:
		cons, prod, err := startMSE(src.URL, "")
		if err != nil {
			s.markReady(err)
			return
		}
		s.mu.Lock()
		s.codecs = mp4.MimeCodecs(cons.Codecs())
		s.mu.Unlock()
		go func() {
			<-ctx.Done()
			_ = prod.Stop()
		}()
		go func() { _ = prod.Start() }()
		_, _ = cons.WriteTo(s)
		s.markReady(errors.New("the camera's stream ended"))
	case backend.LiveMSE:
		d := websocket.Dialer{HandshakeTimeout: 10 * time.Second, ReadBufferSize: 64 << 10, WriteBufferSize: 1024}
		up, _, err := d.DialContext(ctx, src.URL, nil)
		if err != nil {
			s.markReady(errors.New("could not reach the camera's live stream"))
			return
		}
		go func() {
			<-ctx.Done()
			_ = up.Close()
		}()
		defer up.Close()
		if err := up.WriteJSON(wsMessage{Type: "mse", Value: hlsCodecs}); err != nil {
			s.markReady(err)
			return
		}
		for {
			mt, b, err := up.ReadMessage()
			if err != nil {
				s.markReady(errors.New("the camera's stream ended"))
				return
			}
			if mt == websocket.TextMessage {
				var m wsMessage
				_ = json.Unmarshal(b, &m)
				switch m.Type {
				case "mse":
					s.mu.Lock()
					s.codecs = codecsFromMime(m.Value)
					s.mu.Unlock()
				case "error":
					s.markReady(errors.New(m.Value))
					return
				}
				continue
			}
			_, _ = s.Write(b)
		}
	default:
		s.markReady(errors.New("unsupported live source"))
	}
}

var mimeCodecs = regexp.MustCompile(`codecs="([^"]*)"`)

// codecsFromMime: `video/mp4; codecs="avc1.640029,mp4a.40.2"` → `avc1.640029,mp4a.40.2`.
func codecsFromMime(mime string) string {
	if m := mimeCodecs.FindStringSubmatch(mime); m != nil {
		return m[1]
	}
	return ""
}

// hlsCodecsAttr is safe to put inside CODECS="…".
func hlsCodecsAttr(c string) string {
	return strings.Map(func(r rune) rune {
		if r == '"' || r == '\n' || r == '\r' {
			return -1
		}
		return r
	}, c)
}

func (h *hub) handleLiveHLS(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	sys, native, ok := h.camera(w, r, id)
	if !ok {
		return
	}
	if h.hls.count() >= hlsMaxSessions {
		apiError(w, http.StatusServiceUnavailable, "busy", errHLSBusy.Error())
		return
	}
	src, err := sys.b.Live(r.Context(), native, r.URL.Query().Get("quality"))
	if err != nil {
		backendError(w, err)
		return
	}
	base := h.ctx
	if base == nil {
		base = context.Background()
	}
	ctx, cancel := context.WithCancel(base)
	s := &hlsSession{id: newSessionID(), grantID: grantFrom(r).ID, camera: id, ready: make(chan struct{}), cancel: cancel}
	if err := h.hls.add(s); err != nil {
		cancel()
		apiError(w, http.StatusServiceUnavailable, "busy", err.Error())
		return
	}
	go runHLSSource(ctx, s, src)

	select {
	case <-s.ready:
	case <-time.After(hlsStartWait):
		s.markReady(errors.New("the camera didn't send any video"))
	case <-r.Context().Done():
		h.hls.remove(s.id)
		return
	}
	s.mu.Lock()
	failed, codecs := s.err, s.codecs
	s.mu.Unlock()
	if failed != nil {
		h.hls.remove(s.id)
		apiError(w, http.StatusBadGateway, "upstream", failed.Error())
		return
	}
	attr := ""
	if c := hlsCodecsAttr(codecs); c != "" {
		attr = `,CODECS="` + c + `"`
	}
	w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
	w.Header().Set("Cache-Control", "no-store")
	// Relative to /v1/cameras/{id}/live.m3u8, so the session's files stay under the camera.
	_, _ = fmt.Fprintf(w, "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000%s\nhls/%s/playlist.m3u8%s\n", attr, s.id, tokenQuery(r))
}

func (h *hub) handleLiveHLSFile(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, _, ok := h.camera(w, r, id); !ok {
		return
	}
	s := h.hls.get(r.PathValue("sid"))
	if s == nil || s.grantID != grantFrom(r).ID || s.camera != id {
		apiError(w, http.StatusNotFound, "not_found", "This live stream has ended.")
		return
	}
	s.alive.Reset(hlsKeepalive)
	w.Header().Set("Cache-Control", "no-store")
	file := r.PathValue("file")
	switch {
	case file == "playlist.m3u8":
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		_, _ = w.Write([]byte(s.playlist(tokenQuery(r))))
	case file == "init.mp4":
		b := s.take(r.Context(), true)
		if b == nil {
			apiError(w, http.StatusNotFound, "not_found", "No video yet.")
			return
		}
		w.Header().Set("Content-Type", "video/mp4")
		_, _ = w.Write(b)
	case strings.HasPrefix(file, "s") && strings.HasSuffix(file, ".m4s"):
		b := s.take(r.Context(), false)
		if b == nil {
			apiError(w, http.StatusNotFound, "not_found", "No video yet.")
			return
		}
		w.Header().Set("Content-Type", "video/iso.segment")
		_, _ = w.Write(b)
	default:
		apiError(w, http.StatusNotFound, "not_found", "Not found.")
	}
}
