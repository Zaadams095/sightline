package wgtunnel

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/AlexxIT/go2rtc/pkg/core"
	"github.com/AlexxIT/go2rtc/pkg/mp4"
	"github.com/AlexxIT/go2rtc/pkg/rtsp"
	"github.com/gorilla/websocket"
)

// RTSP restreaming for cameras added by URL. Each source gets a loopback HTTP server that
// speaks go2rtc's WebSocket MSE protocol at /api/ws, so the app's live player works the
// same for Frigate and plain RTSP cameras. go2rtc's RTSP client dials sockets itself, so
// it connects to a loopback TCP forwarder that reaches the camera directly or via the tunnel.

type rtspSource struct {
	rawURL    string
	tls       bool // rtsps: the forwarder must pass the TLS stream through untouched
	port      int
	viaTunnel atomic.Bool
	fwd       net.Listener
	server    *http.Server
	conns     *connSet
}

var (
	rtspMu      sync.Mutex
	rtspSources = map[int]*rtspSource{}
)

// upgrader accepts only our own player page (loopback origin of this listener); see loopback.go.
func (s *rtspSource) upgrader() *websocket.Upgrader {
	return &websocket.Upgrader{
		ReadBufferSize:  1024,
		WriteBufferSize: 64 << 10,
		CheckOrigin:     func(r *http.Request) bool { return loopbackOrigin(r.Header.Get("Origin"), s.port) },
	}
}

// AddRTSPSource registers an RTSP camera and returns the loopback port serving /api/ws.
func AddRTSPSource(rawURL string, viaTunnel bool) (int, error) {
	u, err := url.Parse(rawURL)
	if err != nil || (u.Scheme != "rtsp" && u.Scheme != "rtsps") || u.Host == "" {
		return 0, fmt.Errorf("invalid RTSP URL")
	}
	target := u.Host
	if u.Port() == "" {
		defPort := "554"
		if u.Scheme == "rtsps" {
			defPort = "322"
		}
		target = net.JoinHostPort(u.Hostname(), defPort)
	}

	s := &rtspSource{rawURL: rawURL, tls: u.Scheme == "rtsps", conns: newConnSet()}
	s.viaTunnel.Store(viaTunnel)

	if s.fwd, err = net.Listen("tcp", "127.0.0.1:0"); err != nil {
		return 0, err
	}
	go s.forward(target)

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		s.fwd.Close()
		return 0, err
	}
	port := ln.Addr().(*net.TCPAddr).Port
	s.port = port
	mux := http.NewServeMux()
	mux.HandleFunc("/api/ws", s.serveWS)
	s.server = &http.Server{Handler: guardLoopback(port, mux), ReadHeaderTimeout: 10 * time.Second, ConnState: s.conns.track}
	go s.server.Serve(ln) //nolint:errcheck // returns on RemoveRTSPSource

	rtspMu.Lock()
	rtspSources[port] = s
	rtspMu.Unlock()
	return port, nil
}

// SetRTSPViaTunnel switches a source between direct and tunnel dialing (new sessions only).
func SetRTSPViaTunnel(port int, viaTunnel bool) {
	rtspMu.Lock()
	defer rtspMu.Unlock()
	if s := rtspSources[port]; s != nil {
		s.viaTunnel.Store(viaTunnel)
	}
}

func RemoveRTSPSource(port int) {
	rtspMu.Lock()
	s := rtspSources[port]
	delete(rtspSources, port)
	rtspMu.Unlock()
	if s != nil {
		s.server.Close()
		s.fwd.Close()
		s.conns.closeAll() // live WebSockets and camera connections
	}
}

// forward pipes loopback connections to the camera, directly or through the tunnel.
func (s *rtspSource) forward(target string) {
	for {
		c, err := s.fwd.Accept()
		if err != nil {
			return
		}
		s.conns.add(c)
		go func() {
			defer s.conns.remove(c)
			defer c.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			up, err := dial(ctx, "tcp", target, s.viaTunnel.Load())
			cancel()
			if err != nil {
				return
			}
			defer up.Close()
			done := make(chan struct{}, 2)
			go func() {
				if s.tls {
					io.Copy(up, c) // encrypted: can't (and needn't) inspect requests
				} else {
					copyWithPlaybackRange(up, c)
				}
				done <- struct{}{}
			}()
			go func() { io.Copy(c, up); done <- struct{}{} }()
			<-done
		}()
	}
}

// loopbackURL rewrites the camera URL to point at the forwarder, keeping credentials/path.
func (s *rtspSource) loopbackURL() string {
	u, _ := url.Parse(s.rawURL)
	u.Host = s.fwd.Addr().String()
	return u.String()
}

type wsMessage struct {
	Type  string `json:"type"`
	Value string `json:"value"`
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

func (s *rtspSource) serveWS(w http.ResponseWriter, r *http.Request) {
	ws, err := s.upgrader().Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer ws.Close()
	var writeMu sync.Mutex
	sendJSON := func(m wsMessage) {
		writeMu.Lock()
		defer writeMu.Unlock()
		_ = ws.WriteJSON(m)
	}

	var prod *rtsp.Conn
	var cons *mp4.Consumer
	defer func() {
		if prod != nil {
			_ = prod.Stop()
		}
		// Stopping the consumer unblocks its WriteTo goroutine; without it every closed
		// stream would leak a goroutine and its muxer.
		if cons != nil {
			_ = cons.Stop()
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
		c, p, err := s.startMSE(msg.Value)
		if err != nil {
			sendJSON(wsMessage{Type: "error", Value: err.Error()})
			return
		}
		prod, cons = p, c
		sendJSON(wsMessage{Type: "mse", Value: mp4.ContentType(c.Codecs())})
		go func() {
			_ = p.Start() // blocks until the stream ends
			ws.Close()
		}()
		go func() {
			_, _ = c.WriteTo(wsWriter{mu: &writeMu, conn: ws})
			ws.Close()
		}()
	}
}

// startMSE connects to the camera and wires its tracks into an fMP4 consumer, matching
// codecs the browser supports (same steps as go2rtc's streams.AddConsumer).
func (s *rtspSource) startMSE(codecs string) (*mp4.Consumer, *rtsp.Conn, error) {
	var consMedias []*core.Media
	if codecs != "" {
		consMedias = mp4.ParseCodecs(codecs, true)
	}
	cons := mp4.NewConsumer(consMedias)

	prod := rtsp.NewClient(s.loopbackURL())
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

// RTSPSourcesJSON lists active sources (for diagnostics).
func RTSPSourcesJSON() string {
	rtspMu.Lock()
	defer rtspMu.Unlock()
	ports := make([]int, 0, len(rtspSources))
	for p := range rtspSources {
		ports = append(ports, p)
	}
	b, _ := json.Marshal(ports)
	return string(b)
}
