package rtsp

import (
	"bufio"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/textproto"
	"strings"
	"testing"

	"github.com/zachadams/sightline/bridge/backend"
	"github.com/zachadams/sightline/bridge/backend/httpx"
)

func TestParseStreams(t *testing.T) {
	cfg := backend.Config{Kind: kind, Name: "Garage", Username: "admin", Password: "p@ss"}
	cfg.Set("camera1", "rtsp://192.168.1.50:554/stream1")
	cfg.Set("camera3", "Back yard | 192.168.1.51/live/main | rtsp://u:x@192.168.1.51/live/sub")
	cfg.Set(FieldCameras, "# comment\nPorch | rtsps://192.168.1.52/s\r\n\n")
	s, err := ParseStreams(cfg)
	if err != nil {
		t.Fatal(err)
	}
	want := []Stream{
		{ID: "camera1", Name: "Garage 1", Main: "rtsp://admin:p%40ss@192.168.1.50:554/stream1"},
		{ID: "camera3", Name: "Back yard", Main: "rtsp://admin:p%40ss@192.168.1.51/live/main", Sub: "rtsp://u:x@192.168.1.51/live/sub"},
		{ID: "line2", Name: "Porch", Main: "rtsps://admin:p%40ss@192.168.1.52/s"},
	}
	if fmt.Sprint(s) != fmt.Sprint(want) {
		t.Fatalf("streams =\n%+v\nwant\n%+v", s, want)
	}

	one := backend.Config{Kind: kind, Name: "Shed"}
	one.Set("camera1", "rtsp://10.0.0.2/h264")
	if s, _ := ParseStreams(one); len(s) != 1 || s[0].Name != "Shed" || s[0].Main != "rtsp://10.0.0.2/h264" {
		t.Errorf("single = %+v", s)
	}
	anon := backend.Config{Kind: kind}
	anon.Set("camera1", "rtsp://10.0.0.2/h264")
	if s, _ := ParseStreams(anon); s[0].Name != "Camera 1" {
		t.Errorf("unnamed = %+v", s)
	}

	for raw, wantMsg := range map[string]string{
		"":                           "type the camera's video link",
		"http://192.168.1.50/":       "web page",
		"Front door":                 "has no rtsp:// link",
		"rtmp://192.168.1.50/live":   "should start with rtsp://",
		"Front | rtsp:///nohost/x/y": "doesn't look like a video link",
	} {
		c := backend.Config{Kind: kind}
		c.Set("camera1", raw)
		if _, err := ParseStreams(c); err == nil || !strings.Contains(err.Error(), wantMsg) {
			t.Errorf("%q: err = %v, want %q", raw, err, wantMsg)
		}
	}
}

func TestBackend(t *testing.T) {
	cfg := backend.Config{ID: "rtsp", Kind: kind}
	cfg.Set("camera1", "Door | rtsp://10.0.0.2/main | rtsp://10.0.0.2/sub")
	cfg.Set("camera2", "rtsp://10.0.0.3/only")
	b, err := backend.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	cams, _ := b.Cameras(ctx)
	if len(cams) != 2 || cams[0].Name != "Door" || cams[1].Name != "Camera 2" || cams[1].ID != "camera2" {
		t.Fatalf("cameras = %+v", cams)
	}
	if l, _ := b.Live(ctx, "camera1", "sub"); l.Kind != backend.LiveRTSP || l.URL != "rtsp://10.0.0.2/sub" {
		t.Errorf("sub = %+v", l)
	}
	if l, _ := b.Live(ctx, "camera2", "sub"); l.URL != "rtsp://10.0.0.3/only" {
		t.Errorf("sub fallback = %+v", l)
	}
	if _, err := b.Live(ctx, "camera9", "main"); !errors.Is(err, backend.ErrNotFound) {
		t.Errorf("unknown camera: %v", err)
	}
	if b.Capabilities() != (backend.Capabilities{}) {
		t.Errorf("capabilities = %+v", b.Capabilities())
	}
	if _, _, err := b.Snapshot(ctx, "camera1", 0); !errors.Is(err, backend.ErrUnsupported) {
		t.Errorf("snapshot: %v", err)
	}
	if err := b.Watch(ctx, nil); !errors.Is(err, backend.ErrUnsupported) {
		t.Errorf("watch: %v", err)
	}
	if _, err := b.Events(ctx, backend.EventQuery{}); !errors.Is(err, backend.ErrUnsupported) {
		t.Errorf("events: %v", err)
	}
	if err := b.PTZ(ctx, "camera1", "STOP"); !errors.Is(err, backend.ErrUnsupported) {
		t.Errorf("ptz: %v", err)
	}
}

// fakeRTSP answers DESCRIBE like a camera: Basic auth, one known path.
func fakeRTSP(t *testing.T, user, pass, path string) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go serveRTSP(c, user, pass, path)
		}
	}()
	return ln.Addr().String()
}

func serveRTSP(c net.Conn, user, pass, path string) {
	defer c.Close()
	r := textproto.NewReader(bufio.NewReader(c))
	for {
		line, err := r.ReadLine()
		if err != nil {
			return
		}
		hdr, err := r.ReadMIMEHeader()
		if err != nil {
			return
		}
		parts := strings.Fields(line)
		if len(parts) < 2 {
			return
		}
		cseq := hdr.Get("Cseq")
		want := "Basic " + base64.StdEncoding.EncodeToString([]byte(user+":"+pass))
		var resp string
		switch {
		case hdr.Get("Authorization") != want:
			resp = "RTSP/1.0 401 Unauthorized\r\nCSeq: " + cseq + "\r\nWWW-Authenticate: Basic realm=\"cam\"\r\n\r\n"
		case !strings.HasSuffix(parts[1], path):
			resp = "RTSP/1.0 404 Not Found\r\nCSeq: " + cseq + "\r\n\r\n"
		default:
			sdp := "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=cam\r\nt=0 0\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\na=control:trackID=1\r\n"
			resp = fmt.Sprintf("RTSP/1.0 200 OK\r\nCSeq: %s\r\nContent-Type: application/sdp\r\nContent-Length: %d\r\n\r\n%s", cseq, len(sdp), sdp)
		}
		if _, err := c.Write([]byte(resp)); err != nil {
			return
		}
	}
}

func TestProbe(t *testing.T) {
	addr := fakeRTSP(t, "admin", "secret", "/stream1")
	ctx := context.Background()
	probe := func(link, user, pass string) error {
		c := backend.Config{Kind: kind, Username: user, Password: pass}
		c.Set("camera1", link)
		return backend.Probe(ctx, c)
	}
	if err := probe("rtsp://"+addr+"/stream1", "admin", "secret"); err != nil {
		t.Fatalf("good link: %v", err)
	}
	if err := probe("rtsp://admin:secret@"+addr+"/stream1", "", ""); err != nil {
		t.Fatalf("login in the link: %v", err)
	}
	err := probe("rtsp://"+addr+"/stream1", "admin", "wrong")
	if !errors.Is(err, httpx.ErrAuth) || !strings.Contains(err.Error(), "username or password") {
		t.Errorf("wrong password: %v", err)
	}
	err = probe("rtsp://"+addr+"/stream1", "", "")
	if !errors.Is(err, httpx.ErrAuth) || !strings.Contains(err.Error(), "wants a username and password") {
		t.Errorf("no login: %v", err)
	}
	err = probe("rtsp://"+addr+"/nope", "admin", "secret")
	if err == nil || !strings.Contains(err.Error(), "doesn't know that video link") {
		t.Errorf("wrong path: %v", err)
	}

	// Nothing listening: the network error comes back as is, for the Hub to explain.
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	dead := ln.Addr().String()
	ln.Close()
	err = probe("rtsp://"+dead+"/x", "", "")
	var opErr *net.OpError
	if !errors.As(err, &opErr) || !httpx.Unreachable(err) {
		t.Errorf("closed port: %v", err)
	}

	// Several cameras: the failing one is named.
	c := backend.Config{Kind: kind, Username: "admin", Password: "secret"}
	c.Set("camera1", "rtsp://"+addr+"/stream1")
	c.Set("camera2", "Side gate | rtsp://"+dead+"/x")
	if err := backend.Probe(ctx, c); err == nil || !strings.HasPrefix(err.Error(), "Side gate: nothing answered") {
		t.Errorf("multi: %v", err)
	}

	// Health: the dead camera is offline.
	b, _ := New(c)
	h, err := b.Health(ctx)
	if err != nil || len(h.Offline) != 1 || h.Offline[0] != "camera2" {
		t.Errorf("health = %+v %v", h, err)
	}
}
