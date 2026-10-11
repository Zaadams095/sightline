package wgtunnel

import (
	"bufio"
	"bytes"
	"fmt"
	"net"
	"net/textproto"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// fakeCamera is a minimal RTSP server with one H.264 track, enough for DESCRIBE/SETUP/PLAY.
func fakeCamera(t *testing.T, user, pass string) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	sdp := "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=cam\r\nt=0 0\r\n" +
		"m=video 0 RTP/AVP 96\r\na=control:track1\r\na=rtpmap:96 H264/90000\r\n" +
		"a=fmtp:96 packetization-mode=1;profile-level-id=64001f;sprop-parameter-sets=Z2QAH6zZQFAFuhAAAAMAEAAAAwPA8YMZYA==,aOvjyyLA\r\n"

	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
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
					method := strings.Fields(line)[0]
					cseq := hdr.Get("Cseq")
					if user != "" && method != "OPTIONS" && hdr.Get("Authorization") == "" {
						fmt.Fprintf(c, "RTSP/1.0 401 Unauthorized\r\nCSeq: %s\r\nWWW-Authenticate: Basic realm=\"cam\"\r\n\r\n", cseq)
						continue
					}
					switch method {
					case "OPTIONS":
						fmt.Fprintf(c, "RTSP/1.0 200 OK\r\nCSeq: %s\r\nPublic: DESCRIBE, SETUP, PLAY, TEARDOWN\r\n\r\n", cseq)
					case "DESCRIBE":
						fmt.Fprintf(c, "RTSP/1.0 200 OK\r\nCSeq: %s\r\nContent-Type: application/sdp\r\nContent-Length: %d\r\n\r\n%s", cseq, len(sdp), sdp)
					case "SETUP":
						fmt.Fprintf(c, "RTSP/1.0 200 OK\r\nCSeq: %s\r\nSession: 12345;timeout=60\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n", cseq)
					case "PLAY":
						fmt.Fprintf(c, "RTSP/1.0 200 OK\r\nCSeq: %s\r\nSession: 12345\r\n\r\n", cseq)
					default:
						fmt.Fprintf(c, "RTSP/1.0 200 OK\r\nCSeq: %s\r\n\r\n", cseq)
					}
				}
			}(c)
		}
	}()
	return ln.Addr().String()
}

func TestRTSPToMSE(t *testing.T) {
	addr := fakeCamera(t, "admin", "secret")
	port, err := AddRTSPSource("rtsp://admin:secret@"+addr+"/stream1", false)
	if err != nil {
		t.Fatal(err)
	}
	defer RemoveRTSPSource(port)

	ws, _, err := websocket.DefaultDialer.Dial(fmt.Sprintf("ws://127.0.0.1:%d/api/ws", port), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	ws.SetReadDeadline(time.Now().Add(10 * time.Second))

	if err := ws.WriteJSON(wsMessage{Type: "mse", Value: "avc1.640029,avc1.64002A,mp4a.40.2,opus"}); err != nil {
		t.Fatal(err)
	}
	var reply wsMessage
	if err := ws.ReadJSON(&reply); err != nil {
		t.Fatal(err)
	}
	if reply.Type != "mse" || !strings.Contains(reply.Value, "avc1") {
		t.Fatalf("reply = %+v", reply)
	}
	kind, init, err := ws.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	if kind != websocket.BinaryMessage || len(init) < 8 || !bytes.Equal(init[4:8], []byte("ftyp")) {
		t.Fatalf("expected fMP4 init segment, got kind=%d % x", kind, init[:min(16, len(init))])
	}
}

func TestRTSPBadPath(t *testing.T) {
	if _, err := AddRTSPSource("http://not-rtsp", false); err == nil {
		t.Error("expected error for non-RTSP URL")
	}
}
