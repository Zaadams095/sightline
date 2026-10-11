package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestLiveHLS(t *testing.T) {
	// Upstream speaking go2rtc's MSE protocol: init segment, then a fragment every 100 ms.
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		var m wsMessage
		if ws.ReadJSON(&m) != nil || m.Type != "mse" || !strings.Contains(m.Value, "avc1") {
			return
		}
		_ = ws.WriteJSON(wsMessage{Type: "mse", Value: `video/mp4; codecs="avc1.640029,mp4a.40.2"`})
		_ = ws.WriteMessage(websocket.BinaryMessage, []byte("INIT"))
		for i := 0; i < 50; i++ {
			if ws.WriteMessage(websocket.BinaryMessage, []byte("FRAG")) != nil {
				return
			}
			time.Sleep(100 * time.Millisecond)
		}
	}))
	defer upstream.Close()
	th := newTestHub(t)
	th.primary.liveURL = "ws" + strings.TrimPrefix(upstream.URL, "http") + "/live/mse/api/ws"

	get := func(path string) (int, string) {
		t.Helper()
		resp, err := http.Get(th.srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(b)
	}

	tok := th.tokens[roleLive]
	code, master := get("/v1/cameras/front/live.m3u8?token=" + tok)
	if code != 200 || !strings.Contains(master, `CODECS="avc1.640029,mp4a.40.2"`) {
		t.Fatalf("master = %d %q", code, master)
	}
	lines := strings.Split(strings.TrimSpace(master), "\n")
	media := lines[len(lines)-1]
	if !strings.HasPrefix(media, "hls/") || !strings.HasSuffix(media, "/playlist.m3u8?token="+tok) {
		t.Fatalf("media playlist uri = %q", media)
	}
	base := "/v1/cameras/front/" + strings.TrimSuffix(media, "playlist.m3u8?token="+tok)

	code, pl := get(base + "playlist.m3u8?token=" + tok)
	if code != 200 || !strings.Contains(pl, `#EXT-X-MAP:URI="init.mp4?token=`+tok+`"`) || !strings.Contains(pl, "s0.m4s?token=") {
		t.Fatalf("playlist = %d %q", code, pl)
	}
	if code, b := get(base + "init.mp4?token=" + tok); code != 200 || b != "INIT" {
		t.Fatalf("init = %d %q", code, b)
	}
	if code, b := get(base + "s0.m4s?token=" + tok); code != 200 || !strings.HasPrefix(b, "FRAG") {
		t.Fatalf("segment = %d %q", code, b)
	}
	if _, pl := get(base + "playlist.m3u8?token=" + tok); !strings.Contains(pl, "MEDIA-SEQUENCE:1") {
		t.Errorf("sequence didn't advance: %q", pl)
	}

	// Another grant can't use this session, even for a camera it may see.
	if code, _ := get(base + "init.mp4?token=" + th.tokens[roleOwner]); code != 404 {
		t.Errorf("other grant: HTTP %d", code)
	}
	// No token, no stream; cameras outside the grant are 404.
	if code, _ := get(base + "init.mp4"); code != 401 {
		t.Errorf("no token: HTTP %d", code)
	}
	if code, _ := get("/v1/cameras/back/live.m3u8?token=" + tok); code != 404 {
		t.Errorf("back camera: HTTP %d", code)
	}
}

func TestLiveHLSUpstreamError(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		var m wsMessage
		_ = ws.ReadJSON(&m)
		_ = ws.WriteJSON(wsMessage{Type: "error", Value: "stream not found"})
	}))
	defer upstream.Close()
	th := newTestHub(t)
	th.primary.liveURL = "ws" + strings.TrimPrefix(upstream.URL, "http")
	resp := th.do(t, th.tokens[roleOwner], "GET", "/v1/cameras/front/live.m3u8", nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("HTTP %d, want 502", resp.StatusCode)
	}
	if n := th.h.hls.count(); n != 0 {
		t.Errorf("%d sessions left open", n)
	}
}

func TestCodecsFromMime(t *testing.T) {
	if got := codecsFromMime(`video/mp4; codecs="hvc1.1.6.L153.B0,mp4a.40.2"`); got != "hvc1.1.6.L153.B0,mp4a.40.2" {
		t.Errorf("got %q", got)
	}
	if got := codecsFromMime("video/mp4"); got != "" {
		t.Errorf("got %q", got)
	}
}
