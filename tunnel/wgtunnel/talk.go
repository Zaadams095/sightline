package wgtunnel

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/zachadams/sightline/tunnel/talk"
)

// Two-way audio. The app's microphone page (a WKWebView on this listener's own loopback
// origin, so getUserMedia has a secure context) connects to ws://127.0.0.1:<port>/api/talk and
// sends binary frames of 16-bit little-endian mono PCM at 8 kHz. The server answers
// {"type":"talk","value":"<codec>"} once the camera's speaker is open, or
// {"type":"error","value":"<plain-language reason>"}. The Sightline Hub's
// /v1/cameras/{id}/talk speaks the same protocol, so "ws" targets are relayed unchanged.
//
// "rtsp" and "isapi" targets are dialed by go2rtc's packages, which open sockets themselves,
// so (like the restreamer in rtsp.go) they reach the camera through a loopback TCP forwarder
// that goes direct or through the tunnel.

const (
	talkKindWS = "ws"
	// One talk WebSocket may carry at most this much per message (≈2 s of audio).
	talkMaxMessage = 32 << 10
)

type talkRoute struct {
	kind      string
	rawURL    string
	viaTunnel bool
	port      int
	fwd       net.Listener // rtsp/isapi only
	server    *http.Server
	conns     *connSet
}

var (
	talkMu     sync.Mutex
	talkRoutes = map[int]*talkRoute{}
)

func talkTarget(kind, rawURL string) (string, error) {
	u, err := url.Parse(rawURL)
	if err != nil || u.Host == "" {
		return "", fmt.Errorf("invalid camera address")
	}
	def := map[string]string{"rtsp": "554", "rtsps": "322", "http": "80", "https": "443", "ws": "80", "wss": "443"}[u.Scheme]
	ok := map[string]bool{
		talk.KindRTSP:  u.Scheme == "rtsp" || u.Scheme == "rtsps",
		talk.KindISAPI: u.Scheme == "http",
		talkKindWS:     u.Scheme == "ws" || u.Scheme == "wss",
	}[kind]
	if !ok {
		return "", fmt.Errorf("unsupported talk target %s (%s)", kind, u.Scheme)
	}
	if u.Port() == "" {
		return net.JoinHostPort(u.Hostname(), def), nil
	}
	return u.Host, nil
}

// startForwarder listens on loopback and pipes each connection to target.
func startForwarder(target string, viaTunnel bool, conns *connSet) (net.Listener, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			conns.add(c)
			go func() {
				defer conns.remove(c)
				defer c.Close()
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				up, err := dial(ctx, "tcp", target, viaTunnel)
				cancel()
				if err != nil {
					return
				}
				conns.add(up)
				defer conns.remove(up)
				defer up.Close()
				done := make(chan struct{}, 2)
				go func() { _, _ = io.Copy(up, c); done <- struct{}{} }()
				go func() { _, _ = io.Copy(c, up); done <- struct{}{} }()
				<-done
			}()
		}
	}()
	return ln, nil
}

// viaForwarder rewrites a camera URL to the forwarder, keeping credentials and path.
func viaForwarder(rawURL string, fwd net.Listener) string {
	u, _ := url.Parse(rawURL)
	u.Host = fwd.Addr().String()
	return u.String()
}

// AddTalk starts a loopback talk endpoint for one camera and returns its port. kind is "rtsp"
// (ONVIF backchannel), "isapi" (Hikvision, http://user:pass@host:port) or "ws" (a Sightline Hub
// talk WebSocket, token in the URL).
func AddTalk(kind, rawURL string, viaTunnel bool) (int, error) {
	target, err := talkTarget(kind, rawURL)
	if err != nil {
		return 0, err
	}
	t := &talkRoute{kind: kind, rawURL: rawURL, viaTunnel: viaTunnel, conns: newConnSet()}
	if kind != talkKindWS {
		if t.fwd, err = startForwarder(target, viaTunnel, t.conns); err != nil {
			return 0, err
		}
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		if t.fwd != nil {
			t.fwd.Close()
		}
		return 0, err
	}
	t.port = ln.Addr().(*net.TCPAddr).Port
	mux := http.NewServeMux()
	mux.HandleFunc("/api/talk", t.serveWS)
	t.server = &http.Server{Handler: guardLoopback(t.port, mux), ReadHeaderTimeout: 10 * time.Second, ConnState: t.conns.track}
	go t.server.Serve(ln) //nolint:errcheck // returns on RemoveTalk

	talkMu.Lock()
	talkRoutes[t.port] = t
	talkMu.Unlock()
	return t.port, nil
}

// RemoveTalk hangs up and stops a talk endpoint.
func RemoveTalk(port int) {
	talkMu.Lock()
	t := talkRoutes[port]
	delete(talkRoutes, port)
	talkMu.Unlock()
	if t != nil {
		t.server.Close()
		if t.fwd != nil {
			t.fwd.Close()
		}
		t.conns.closeAll()
	}
}

// ProbeTalk returns the codec the camera's speaker takes (e.g. "PCMU/8000"), or "" when it
// can't take audio from the app (no backchannel, wrong password, unreachable). "ws" targets
// are the Hub's, which answers this itself (GET /v1/cameras/{id}/talk), so they return "".
func ProbeTalk(kind, rawURL string, viaTunnel bool, timeoutMs int) string {
	target, err := talkTarget(kind, rawURL)
	if err != nil || kind == talkKindWS {
		return ""
	}
	conns := newConnSet()
	fwd, err := startForwarder(target, viaTunnel, conns)
	if err != nil {
		return ""
	}
	defer func() {
		fwd.Close()
		conns.closeAll()
	}()
	codec, err := talk.Probe(kind, viaForwarder(rawURL, fwd), time.Duration(timeoutMs)*time.Millisecond)
	if err != nil {
		return ""
	}
	return codec.String()
}

func (t *talkRoute) serveWS(w http.ResponseWriter, r *http.Request) {
	up := websocket.Upgrader{
		ReadBufferSize:  4096,
		WriteBufferSize: 1024,
		CheckOrigin:     func(r *http.Request) bool { return loopbackOrigin(r.Header.Get("Origin"), t.port) },
	}
	ws, err := up.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer ws.Close()
	ws.SetReadLimit(talkMaxMessage)

	if t.kind == talkKindWS {
		t.relay(r.Context(), ws)
		return
	}
	sess, err := talk.Open(t.kind, viaForwarder(t.rawURL, t.fwd))
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
		ws.Close() // the camera hung up
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

// relay pipes the page's talk WebSocket to a Hub's, both ways.
func (t *talkRoute) relay(ctx context.Context, client *websocket.Conn) {
	d := websocket.Dialer{
		HandshakeTimeout: 10 * time.Second,
		NetDialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			return dial(ctx, network, addr, t.viaTunnel)
		},
	}
	upstream, resp, err := d.DialContext(ctx, t.rawURL, nil)
	if err != nil {
		msg := "Couldn't reach the Hub to talk."
		if resp != nil && resp.StatusCode == http.StatusForbidden {
			msg = "Your access doesn't include talking through cameras."
		}
		_ = client.WriteJSON(wsMessage{Type: "error", Value: msg})
		return
	}
	defer upstream.Close()
	done := make(chan struct{}, 2)
	pipe := func(dst, src *websocket.Conn) {
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
	go pipe(upstream, client)
	go pipe(client, upstream)
	<-done
}
