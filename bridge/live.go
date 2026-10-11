package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/AlexxIT/go2rtc/pkg/core"
	"github.com/AlexxIT/go2rtc/pkg/mp4"
	"github.com/AlexxIT/go2rtc/pkg/rtsp"
	"github.com/gorilla/websocket"

	"github.com/zachadams/sightline/bridge/backend"
)

// Live view speaks go2rtc's WebSocket MSE protocol to the app: the client sends
// {"type":"mse","value":"<codecs>"}, the Hub answers {"type":"mse","value":"<mime>"} and then
// streams binary fMP4. Upstream sources are either another go2rtc MSE WebSocket (Frigate's
// built-in go2rtc), piped through unchanged, or an RTSP URL restreamed with go2rtc's packages
// (same approach as tunnel/wgtunnel/rtsp.go).

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

func (h *hub) handleLive(w http.ResponseWriter, r *http.Request) {
	s, native, ok := h.camera(w, r, r.PathValue("id"))
	if !ok {
		return
	}
	quality := r.URL.Query().Get("quality")
	src, err := s.b.Live(r.Context(), native, quality)
	if err != nil {
		backendError(w, err)
		return
	}
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer ws.Close()
	switch src.Kind {
	case backend.LiveMSE:
		pipeMSE(r.Context(), ws, src.URL)
	case backend.LiveRTSP:
		serveRTSP(ws, src.URL)
	default:
		_ = ws.WriteJSON(wsMessage{Type: "error", Value: "unsupported live source"})
	}
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
