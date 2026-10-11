package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/zachadams/sightline/bridge/backend"
)

// fakePlayer is an NVR without HLS VOD: it replays as a stream or hands out MP4 files.
type fakePlayer struct {
	*fakeBackend
	live               *backend.LiveSource
	fileStart, fileEnd float64
	noClips            bool
	fileRanges         []string
}

func (p *fakePlayer) Capabilities() backend.Capabilities {
	c := p.fakeBackend.Capabilities()
	c.Clips = !p.noClips
	return c
}

func (p *fakePlayer) Playback(_ context.Context, cam string, start, end float64) (backend.Playback, error) {
	p.record(fmt.Sprintf("playback %s %.0f-%.0f", cam, start, end))
	if p.live != nil {
		return backend.Playback{Live: p.live}, nil
	}
	return backend.Playback{StartTime: p.fileStart, EndTime: p.fileEnd, File: func(_ context.Context, hdr http.Header) (*http.Response, error) {
		p.fileRanges = append(p.fileRanges, hdr.Get("Range"))
		r := fakeResp("rec.mp4", "video/mp4", "mp4:"+cam)
		r.StatusCode = http.StatusPartialContent
		r.Header.Set("Content-Range", "bytes 0-5/100")
		return r, nil
	}}, nil
}

func usePlayer(th *testHub, p *fakePlayer) {
	p.fakeBackend = th.primary
	th.h.systems[0].b = p
	th.h.playbacks = playbackCache{}
}

func TestPlaybackVODForHLSBackends(t *testing.T) {
	th := newTestHub(t)
	var out playbackView
	th.call(t, th.tokens[roleOwner], "GET", "/v1/recordings/front/playback?start=1000&end=2000", nil, 200, &out)
	if out.Kind != "vod" || out.URL != "/v1/recordings/front/vod.m3u8?start=1000&end=2000" || out.Source != nil {
		t.Errorf("owner = %+v", out)
	}
	// Temporary (4000–8000): clamped, and the token is carried when it came in the query.
	tok := th.tokens[roleTemporary]
	th.call(t, "", "GET", "/v1/recordings/front/playback?start=3000&end=5000&token="+tok, nil, 200, &out)
	if out.URL != "/v1/recordings/front/vod.m3u8?start=4000&end=5000&token="+tok || out.Start != 4000 {
		t.Errorf("temporary = %+v", out)
	}
	for role, want := range map[string]int{roleTemporary: 403, roleLive: 403, roleHousehold: 200} {
		resp := th.do(t, th.tokens[role], "GET", "/v1/recordings/front/playback?start=1000&end=2000", nil)
		resp.Body.Close()
		if resp.StatusCode != want {
			t.Errorf("%s outside window: HTTP %d, want %d", role, resp.StatusCode, want)
		}
	}
	// Household can't see "back".
	resp := th.do(t, th.tokens[roleHousehold], "GET", "/v1/recordings/back/playback?start=1000&end=2000", nil)
	resp.Body.Close()
	if resp.StatusCode != 404 {
		t.Errorf("household back: HTTP %d", resp.StatusCode)
	}
}

func TestPlaybackFilesAreGrantChecked(t *testing.T) {
	th := newTestHub(t)
	p := &fakePlayer{fileStart: 3900, fileEnd: 4600}
	usePlayer(th, p)

	// The owner gets the recorder's file, which begins before the window.
	var out playbackView
	th.call(t, th.tokens[roleOwner], "GET", "/v1/recordings/front/playback?start=4000&end=5000", nil, 200, &out)
	if out.Kind != "stream" || out.Source == nil || out.Source.Kind != "file" ||
		out.Source.URL != "/v1/recordings/front/playback/file.mp4?start=4000&end=5000" || out.Source.StartTime == nil || *out.Source.StartTime != 3900 {
		t.Fatalf("owner = %+v %+v", out, out.Source)
	}
	req, _ := http.NewRequest("GET", th.srv.URL+out.Source.URL, nil)
	req.Header.Set("Authorization", "Bearer "+th.tokens[roleOwner])
	req.Header.Set("Range", "bytes=0-5")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 206 || string(b) != "mp4:front" || resp.Header.Get("Content-Range") != "bytes 0-5/100" || p.fileRanges[0] != "bytes=0-5" {
		t.Errorf("file = %d %q %v %v", resp.StatusCode, b, resp.Header, p.fileRanges)
	}

	// The temporary guest's window starts at 4000, so the 3900 file would leak: the Hub
	// exports exactly the window instead.
	tok := th.tokens[roleTemporary]
	out = playbackView{}
	th.call(t, tok, "GET", "/v1/recordings/front/playback?start=3000&end=5000", nil, 200, &out)
	if out.Source == nil || out.Source.URL != "/v1/recordings/front/clip.mp4?start=4000&end=5000" || out.Source.StartTime != nil {
		t.Errorf("temporary = %+v %+v", out, out.Source)
	}
	// …and can't fetch the file route directly.
	resp = th.do(t, tok, "GET", "/v1/recordings/front/playback/file.mp4?start=4000&end=5000", nil)
	resp.Body.Close()
	if resp.StatusCode != 403 {
		t.Errorf("temporary file: HTTP %d", resp.StatusCode)
	}
	// Without clip export there is nothing safe to give.
	p.noClips = true
	resp = th.do(t, tok, "GET", "/v1/recordings/front/playback?start=4000&end=5000", nil)
	resp.Body.Close()
	if resp.StatusCode != 403 {
		t.Errorf("temporary without clips: HTTP %d", resp.StatusCode)
	}
	// A file known to lie inside the window is fine.
	p.fileStart, p.fileEnd = 4100, 4700
	th.h.playbacks = playbackCache{}
	th.call(t, tok, "GET", "/v1/recordings/front/playback?start=4100&end=4700", nil, 200, &out)
	if out.Source == nil || !strings.Contains(out.Source.URL, "/playback/file.mp4?start=4100&end=4700") {
		t.Errorf("inside window = %+v", out.Source)
	}
	// Media routes need the window entirely inside the grant (as issued).
	resp = th.do(t, tok, "GET", "/v1/recordings/front/playback/file.mp4?start=3000&end=5000", nil)
	resp.Body.Close()
	if resp.StatusCode != 403 {
		t.Errorf("forged file window: HTTP %d", resp.StatusCode)
	}
	resp = th.do(t, th.tokens[roleLive], "GET", "/v1/recordings/front/playback/file.mp4?start=4100&end=4700", nil)
	resp.Body.Close()
	if resp.StatusCode != 403 {
		t.Errorf("live-only file: HTTP %d", resp.StatusCode)
	}
}

func TestPlaybackStreamIsClampedAndCutOff(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		var m wsMessage
		if ws.ReadJSON(&m) != nil {
			return
		}
		_ = ws.WriteJSON(wsMessage{Type: "mse", Value: "video/mp4"})
		for { // a recorder that ignores the end time and keeps going
			if ws.WriteMessage(websocket.BinaryMessage, []byte("frag")) != nil {
				return
			}
			time.Sleep(20 * time.Millisecond)
		}
	}))
	defer upstream.Close()
	th := newTestHub(t)
	p := &fakePlayer{live: &backend.LiveSource{Kind: backend.LiveMSE, URL: "ws" + strings.TrimPrefix(upstream.URL, "http")}}
	usePlayer(th, p)
	oldSlack := replaySlack
	replaySlack = 200 * time.Millisecond
	defer func() { replaySlack = oldSlack }()

	tok := th.tokens[roleTemporary]
	var out playbackView
	th.call(t, tok, "GET", "/v1/recordings/front/playback?start=7000&end=9000", nil, 200, &out)
	if out.Kind != "stream" || out.Source == nil || out.Source.Kind != "mse" || out.Source.URL != "/v1/recordings/front/playback/stream?start=7000&end=8000" {
		t.Fatalf("stream = %+v %+v", out, out.Source)
	}
	if want := "playback front 7000-8000"; !strings.Contains(strings.Join(th.primary.calls, ","), want) {
		t.Errorf("backend calls = %v, want %s", th.primary.calls, want)
	}
	// Outside the window: refused before any upgrade.
	_, resp, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(th.srv.URL, "http")+"/v1/recordings/front/playback/stream?start=7000&end=9000&token="+tok, nil)
	if err == nil || resp == nil || resp.StatusCode != 403 {
		t.Errorf("forged stream window: %v %v", err, resp)
	}

	// A one-second window: the Hub ends the replay shortly after, whatever the recorder does.
	th.call(t, tok, "GET", "/v1/recordings/front/playback?start=7000&end=7001", nil, 200, &out)
	c, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(th.srv.URL, "http")+out.Source.URL+"&token="+tok, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_ = c.WriteJSON(wsMessage{Type: "mse", Value: "avc1.640029"})
	var m wsMessage
	if err := c.ReadJSON(&m); err != nil || m.Type != "mse" {
		t.Fatalf("mse reply = %+v, %v", m, err)
	}
	began := time.Now()
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		if _, _, err := c.ReadMessage(); err != nil {
			break
		}
	}
	if d := time.Since(began); d > 3*time.Second {
		t.Errorf("replay ran %v past a 1 s window", d)
	}
}

func TestInfoReportsSystemCapabilities(t *testing.T) {
	th := newTestHub(t)
	th.h.systems[1].b = &fakePlayer{fakeBackend: &fakeBackend{id: "nvr", cams: []string{"garage"}}, noClips: true}
	var info struct {
		Systems []systemInfo `json:"systems"`
		Caps    capabilities `json:"capabilities"`
	}
	th.call(t, th.tokens[roleOwner], "GET", "/v1/info", nil, 200, &info)
	if len(info.Systems) != 2 || !info.Systems[0].Capabilities.Clips || info.Systems[1].Capabilities.Clips || !info.Caps.Clips || info.Caps.Alerts {
		t.Errorf("owner info = %+v", info)
	}
	th.call(t, th.tokens[roleLive], "GET", "/v1/info", nil, 200, &info)
	if info.Caps.Events || info.Caps.Recordings || !info.Caps.Live || !info.Caps.Snapshots {
		t.Errorf("live-only caps = %+v", info.Caps)
	}
}
