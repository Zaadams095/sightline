package wgtunnel

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/zachadams/sightline/tunnel/talk/talktest"
)

func talkDial(t *testing.T, port int, origin string) (*websocket.Conn, *http.Response, error) {
	t.Helper()
	h := http.Header{}
	if origin != "" {
		h.Set("Origin", origin)
	}
	return websocket.DefaultDialer.Dial(fmt.Sprintf("ws://127.0.0.1:%d/api/talk", port), h)
}

func TestTalkThroughLoopback(t *testing.T) {
	cam, err := talktest.NewCamera("PCMA/8000")
	if err != nil {
		t.Fatal(err)
	}
	defer cam.Close()

	if got := ProbeTalk("rtsp", cam.URL, false, 5000); got != "PCMA/8000" {
		t.Errorf("ProbeTalk = %q", got)
	}

	port, err := AddTalk("rtsp", cam.URL, false)
	if err != nil {
		t.Fatal(err)
	}
	defer RemoveTalk(port)

	// Another web page can't use the camera's speaker.
	if _, resp, err := talkDial(t, port, "https://evil.example"); err == nil || resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Errorf("foreign origin: %v %v", err, resp)
	}

	ws, _, err := talkDial(t, port, fmt.Sprintf("http://127.0.0.1:%d", port))
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	var m wsMessage
	if err := ws.ReadJSON(&m); err != nil || m.Type != "talk" || m.Value != "PCMA/8000" {
		t.Fatalf("ready = %+v, %v", m, err)
	}
	// Silence in, A-law silence out. go2rtc repacks PCMA into 1024-byte packets for cameras.
	frame := make([]byte, 320)
	deadline := time.After(5 * time.Second)
	for {
		if err := ws.WriteMessage(websocket.BinaryMessage, frame); err != nil {
			t.Fatal(err)
		}
		select {
		case p := <-cam.Packets:
			if p.PayloadType != 8 || len(p.Payload) == 0 || p.Payload[0] != 0xD5 {
				t.Fatalf("packet %+v % x", p.Header, p.Payload[:4])
			}
			RemoveTalk(port)
			if _, _, err := ws.ReadMessage(); err == nil {
				t.Error("talk WebSocket still open after RemoveTalk")
			}
			return
		case <-deadline:
			t.Fatal("camera received no audio")
		case <-time.After(20 * time.Millisecond):
		}
	}
}

func TestTalkNoSpeaker(t *testing.T) {
	cam, _ := talktest.NewCamera("")
	defer cam.Close()
	if got := ProbeTalk("rtsp", cam.URL, false, 5000); got != "" {
		t.Errorf("ProbeTalk = %q", got)
	}
	port, err := AddTalk("rtsp", cam.URL, false)
	if err != nil {
		t.Fatal(err)
	}
	defer RemoveTalk(port)
	ws, _, err := talkDial(t, port, "")
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	var m wsMessage
	if err := ws.ReadJSON(&m); err != nil || m.Type != "error" || !strings.Contains(m.Value, "speaker") {
		t.Errorf("reply = %+v, %v", m, err)
	}
	if _, err := AddTalk("isapi", "rtsp://x/", false); err == nil {
		t.Error("isapi with an rtsp URL accepted")
	}
}

func TestTalkRelaysToHub(t *testing.T) {
	got := make(chan []byte, 1)
	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("token") != "abc" {
			http.Error(w, "no", http.StatusForbidden)
			return
		}
		ws, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		_ = ws.WriteJSON(wsMessage{Type: "talk", Value: "PCMU/8000"})
		_, b, _ := ws.ReadMessage()
		got <- b
	}))
	defer hub.Close()
	wsURL := "ws" + strings.TrimPrefix(hub.URL, "http") + "/v1/cameras/front/talk?token="

	port, _ := AddTalk("ws", wsURL+"abc", false)
	defer RemoveTalk(port)
	ws, _, err := talkDial(t, port, "")
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	var m wsMessage
	if err := ws.ReadJSON(&m); err != nil || m.Type != "talk" {
		t.Fatalf("ready = %+v, %v", m, err)
	}
	_ = ws.WriteMessage(websocket.BinaryMessage, []byte{1, 2, 3, 4})
	select {
	case b := <-got:
		if string(b) != "\x01\x02\x03\x04" {
			t.Errorf("hub got % x", b)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("nothing relayed")
	}

	// A guest the Hub refuses gets a plain answer.
	port2, _ := AddTalk("ws", wsURL+"nope", false)
	defer RemoveTalk(port2)
	ws2, _, err := talkDial(t, port2, "")
	if err != nil {
		t.Fatal(err)
	}
	defer ws2.Close()
	if err := ws2.ReadJSON(&m); err != nil || m.Type != "error" || !strings.Contains(m.Value, "access") {
		t.Errorf("refused = %+v, %v", m, err)
	}
}
