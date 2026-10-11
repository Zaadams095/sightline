package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/AlexxIT/go2rtc/pkg/core"
	"github.com/AlexxIT/go2rtc/pkg/mp4"
	"github.com/AlexxIT/go2rtc/pkg/rtsp"
	"github.com/gorilla/websocket"

	"github.com/zachadams/sightline/bridge/backend"
	"github.com/zachadams/sightline/bridge/backend/httpx"
)

// Live view speaks go2rtc's WebSocket MSE protocol to the app: the client sends
// {"type":"mse","value":"<codecs>"}, the Hub answers {"type":"mse","value":"<mime>"} and then
// streams binary fMP4. Upstream sources are either another go2rtc MSE WebSocket (Frigate's
// built-in go2rtc) or an RTSP URL restreamed with go2rtc's packages (same approach as
// tunnel/wgtunnel/rtsp.go); live view shares and caches them (live_shared.go). Recording
// playback (playback.go) uses pipeMSE/serveRTSP below: one private stream per viewer.

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 64 << 10,
	// Authenticated by token, not cookies, so cross-origin pages gain nothing; the app's
	// player runs in a WebView with a null/file origin.
	CheckOrigin: func(*http.Request) bool { return true },
}

type wsMessage struct {
	Type  string `json:"type"`
	Value string `json:"value"`
}

// liveQuality is the stream a live request gets. Through remote access (Tailscale Funnel,
// whose relays limit bandwidth) the sub stream is used unless the app explicitly asks for
// "main"; on the home network the main stream is the default.
func liveQuality(r *http.Request) string {
	q := r.URL.Query().Get("quality")
	if q == "sub" || (isRemote(r) && q != "main") {
		return "sub"
	}
	return "main"
}

func via(r *http.Request) string {
	if isRemote(r) {
		return "remote"
	}
	return "lan"
}

// liveHello is sent after the mime message: how the Hub started this view, so the app's
// startup timing can tell a cached picture from a cold camera connection. go2rtc clients
// ignore message types they don't know.
type liveHello struct {
	Start    string            `json:"start"`
	WaitMs   int64             `json:"waitMs"`
	Upstream liveUpstreamTimes `json:"upstream"`
}

// GET /v1/cameras/{id}/live?quality=main|sub[&codecs=â€¦] (WebSocket, go2rtc's MSE protocol).
//
// The camera's stream is shared by all its viewers and cached from its last keyframe
// (live_shared.go), so a viewer usually gets a picture in its first round trip. Passing the
// player's codecs in the URL saves the round trip of the {"type":"mse"} message: the Hub then
// starts the stream before the upgrade and sends the mime, init segment and cached GOP right
// after it. Without it the Hub waits for that message, as go2rtc does.
func (h *hub) handleLive(w http.ResponseWriter, r *http.Request) {
	t0 := time.Now()
	s, native, ok := h.camera(w, r, r.PathValue("id"))
	if !ok {
		return
	}
	quality := liveQuality(r)
	stat := liveSessionStat{Time: t0.Unix(), Brand: s.cfg.Kind, Via: via(r), Kind: "mse", Quality: quality}
	defer func() {
		stat.Seconds = time.Since(t0).Seconds()
		h.liveStats.add(stat)
		if h.cfg.debug {
			log.Printf("live session %s/%s: %+v", s.cfg.ID, native, stat)
		}
	}()

	codecs, early := r.URL.Query().Get("codecs"), r.URL.Query().Has("codecs")
	startedHere := false
	if early {
		// Start (or find) the stream now; the upgrade and its round trip overlap the connect.
		startedHere = h.prestartLive(s, native, quality, codecs) == "starting"
	}
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		stat.Error = "upgrade"
		return
	}
	defer ws.Close()
	if tc, ok := ws.NetConn().(*net.TCPConn); ok {
		_ = tc.SetNoDelay(true) // Go's default; small control frames must never wait
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	first := make(chan string, 1)
	go func() {
		// Reads until the client goes away (a hijacked connection's request context doesn't
		// notice). The first "mse" message carries the codecs when the URL didn't.
		defer cancel()
		for {
			mt, b, err := ws.ReadMessage()
			if err != nil {
				return
			}
			var m wsMessage
			if mt == websocket.TextMessage && json.Unmarshal(b, &m) == nil && m.Type == "mse" {
				select {
				case first <- m.Value:
				default:
				}
			}
		}
	}()
	if !early {
		t := time.NewTimer(liveStartWait)
		select {
		case codecs = <-first:
		case <-ctx.Done():
			t.Stop()
			return
		case <-t.C:
			stat.Error = "no-codecs"
			return
		}
		t.Stop()
	}
	stat.CodecsMs = sinceMs(t0)

	p, v, j, start, err := h.joinLive(ctx, s, native, quality, codecs, startedHere)
	if err != nil {
		stat.Error = errCategory(err)
		if ctx.Err() == nil {
			_ = ws.WriteJSON(wsMessage{Type: "error", Value: liveErrorText(err)})
		}
		return
	}
	defer p.release(v)
	stat.Start, stat.Upstream = start, upstreamTimes(j.times)
	stat.ReadyMs = sinceMs(t0)

	var sent int64
	sentFrame := false
	send := func(bufs ...[]byte) error {
		_ = ws.SetWriteDeadline(time.Now().Add(liveWriteTimeout))
		wr, err := ws.NextWriter(websocket.BinaryMessage)
		if err != nil {
			return err
		}
		for _, b := range bufs {
			n, err := wr.Write(b)
			sent += int64(n)
			if err != nil {
				return err
			}
		}
		if err := wr.Close(); err != nil {
			return err
		}
		if stat.FirstByteMs == 0 {
			stat.FirstByteMs = sinceMs(t0)
		}
		return nil
	}
	_ = ws.SetWriteDeadline(time.Now().Add(liveWriteTimeout))
	if ws.WriteJSON(wsMessage{Type: "mse", Value: j.mime}) != nil {
		return
	}
	// The init segment and the cached GOP go out as one message: the player can show a frame
	// as soon as it arrives.
	if err := send(j.init, j.gop); err != nil {
		return
	}
	if j.gop != nil {
		sentFrame = true
		stat.FirstFrameMs = sinceMs(t0)
	}
	// After the media, so the mime â†’ binary order go2rtc clients expect is kept.
	hello, _ := json.Marshal(liveHello{Start: start, WaitMs: stat.ReadyMs, Upstream: stat.Upstream})
	if ws.WriteJSON(wsMessage{Type: "hub", Value: string(hello)}) != nil {
		return
	}
	err = v.run(ctx, func(q [][]byte) error {
		if err := send(q...); err != nil {
			return err
		}
		if !sentFrame {
			sentFrame = true
			stat.FirstFrameMs = sinceMs(t0)
		}
		return nil
	})
	if d := time.Since(t0).Seconds(); d > 0 {
		stat.Kbps = int64(float64(sent*8) / d / 1000)
	}
	stat.Dropped = v.droppedCount()
	if err != nil && ctx.Err() == nil && !errors.Is(err, errLiveStopped) && !errors.Is(err, errStreamEnded) {
		_ = ws.SetWriteDeadline(time.Now().Add(5 * time.Second))
		_ = ws.WriteJSON(wsMessage{Type: "error", Value: liveErrorText(err)})
	}
}

// liveErrorText is a stream failure as the player shows it.
func liveErrorText(err error) string {
	switch {
	case errors.Is(err, errLiveBusy), errors.Is(err, errNoVideo), errors.Is(err, errStreamEnded):
		return err.Error()
	case errors.Is(err, backend.ErrNotFound):
		return "the camera was not found"
	case errors.Is(err, backend.ErrUnsupported):
		return "this camera has no live video"
	}
	return httpx.Explain(err).Error()
}

// prestartLive opens the camera's shared stream without waiting for it (a viewer is about
// to join, or POST /warm). It reports "starting", "warm", "busy" or "off".
func (h *hub) prestartLive(s *system, native, quality, codecs string) string {
	p, created, err := h.live.open(liveOpen{
		key: liveKey(s, native, quality), brand: s.cfg.Kind, codecs: codecs,
		resolve: func(ctx context.Context) (backend.LiveSource, error) { return s.b.Live(ctx, native, quality) },
		onErr:   func(err error) { h.noteErr(s, "live", err) },
	})
	if err != nil {
		return "busy"
	}
	p.warm()
	if created {
		return "starting"
	}
	return "warm"
}

// POST /v1/cameras/{id}/warm?quality=main|sub[&codecs=â€¦]: the app is about to open this
// camera (a finger landed on its tile). The Hub connects to the camera now and keeps the
// stream for the grace period, so the WebSocket that follows starts with a picture. Answers
// 202 at once; grant-checked like live view and rate-limited per grant.
func (h *hub) handleLiveWarm(w http.ResponseWriter, r *http.Request) {
	s, native, ok := h.camera(w, r, r.PathValue("id"))
	if !ok {
		return
	}
	g := grantFrom(r)
	if h.warmLimit.blocked(g.ID) {
		apiError(w, http.StatusTooManyRequests, "rate_limited", "Too many requests; try again in a minute.")
		return
	}
	h.warmLimit.fail(g.ID) // counts every warm-up, not only failures
	state := "off"
	if h.live.grace > 0 {
		codecs := r.URL.Query().Get("codecs")
		if codecs == "" {
			codecs = liveDefaultCodecs
		}
		state = h.prestartLive(s, native, liveQuality(r), codecs)
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"state": state, "graceSeconds": int(h.live.grace.Seconds())})
}

// pipeMSE relays every message both ways between the app and an upstream go2rtc WebSocket.
func pipeMSE(ctx context.Context, client *websocket.Conn, upstreamURL string) {
	d := websocket.Dialer{HandshakeTimeout: 10 * time.Second, ReadBufferSize: 64 << 10, WriteBufferSize: 1024}
	up, _, err := d.DialContext(ctx, upstreamURL, nil)
	if err != nil {
		_ = client.WriteJSON(wsMessage{Type: "error", Value: "could not reach the camera's live stream"})
		return
	}
	defer up.Close()
	done := make(chan struct{}, 2)
	relay := func(dst, src *websocket.Conn) {
		defer func() { done <- struct{}{} }()
		for {
			mt, b, err := src.ReadMessage()
			if err != nil {
				return
			}
			if err := dst.WriteMessage(mt, b); err != nil {
				return
			}
		}
	}
	go relay(up, client)
	go relay(client, up)
	<-done
}

// wsWriter adapts the MP4 consumer's byte stream into binary WebSocket frames.
type wsWriter struct {
	mu   *sync.Mutex
	conn *websocket.Conn
}

func (w wsWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if err := w.conn.WriteMessage(websocket.BinaryMessage, p); err != nil {
		return 0, err
	}
	return len(p), nil
}

func serveRTSP(ws *websocket.Conn, rawURL string) {
	var writeMu sync.Mutex
	sendJSON := func(m wsMessage) {
		writeMu.Lock()
		defer writeMu.Unlock()
		_ = ws.WriteJSON(m)
	}
	var prod *rtsp.Conn
	defer func() {
		if prod != nil {
			_ = prod.Stop()
		}
	}()
	for {
		var msg wsMessage
		if err := ws.ReadJSON(&msg); err != nil {
			return // client closed
		}
		if msg.Type != "mse" || prod != nil {
			continue
		}
		cons, p, err := startMSE(rawURL, msg.Value)
		if err != nil {
			sendJSON(wsMessage{Type: "error", Value: err.Error()})
			return
		}
		prod = p
		sendJSON(wsMessage{Type: "mse", Value: mp4.ContentType(cons.Codecs())})
		go func() {
			_ = p.Start() // blocks until the stream ends
			ws.Close()
		}()
		go func() {
			_, _ = cons.WriteTo(wsWriter{mu: &writeMu, conn: ws})
			ws.Close()
		}()
	}
}

// startMSE connects to the camera and wires its tracks into an fMP4 consumer, matching
// codecs the browser supports (same steps as go2rtc's streams.AddConsumer).
func startMSE(rawURL, codecs string) (*mp4.Consumer, *rtsp.Conn, error) {
	var consMedias []*core.Media
	if codecs != "" {
		consMedias = mp4.ParseCodecs(codecs, true)
	}
	cons := mp4.NewConsumer(consMedias)

	prod := rtsp.NewClient(rawURL)
	prod.Timeout = 10
	if err := prod.Dial(); err != nil {
		return nil, nil, friendlyRTSPError(err)
	}
	if err := prod.Describe(); err != nil {
		_ = prod.Stop()
		return nil, nil, friendlyRTSPError(err)
	}
	matched := 0
	for _, consMedia := range cons.GetMedias() {
		for _, prodMedia := range prod.GetMedias() {
			if prodMedia.Direction != core.DirectionRecvonly {
				continue
			}
			prodCodec, consCodec := prodMedia.MatchMedia(consMedia)
			if prodCodec == nil {
				continue
			}
			track, err := prod.GetTrack(prodMedia, prodCodec)
			if err != nil {
				continue
			}
			if err := cons.AddTrack(consMedia, consCodec, track); err != nil {
				continue
			}
			matched++
			break
		}
	}
	if matched == 0 {
		_ = prod.Stop()
		return nil, nil, errors.New("this camera's video format isn't supported (try its H.264 sub-stream)")
	}
	return cons, prod, nil
}

func friendlyRTSPError(err error) error {
	msg := err.Error()
	switch {
	case strings.Contains(msg, "user/pass"):
		return errors.New("the camera rejected the username or password")
	case strings.Contains(msg, "404") || strings.Contains(msg, "wrong response on DESCRIBE"):
		return errors.New("the camera did not recognize that stream path")
	default:
		return fmt.Errorf("could not connect to the camera: %s", msg)
	}
}
