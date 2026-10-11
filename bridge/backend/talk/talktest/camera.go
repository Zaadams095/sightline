// Package talktest is a fake RTSP camera with an ONVIF backchannel, for tests of the talk
// package and its users. Shared by the Hub and tunnel copies; keep them identical.
package talktest

import (
	"bufio"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"

	"github.com/pion/rtp"
)

// Camera answers DESCRIBE with a video track and, when asked for the backchannel, a sendonly
// audio track in Codec (e.g. "PCMU/8000" or "PCMA/8000"); "" offers no backchannel.
type Camera struct {
	Codec string
	URL   string

	ln      net.Listener
	mu      sync.Mutex
	asked   bool
	Packets chan *rtp.Packet
}

func NewCamera(codec string) (*Camera, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	c := &Camera{Codec: codec, ln: ln, Packets: make(chan *rtp.Packet, 1024)}
	c.URL = "rtsp://user:pass@" + ln.Addr().String() + "/stream1"
	go c.serve()
	return c, nil
}

// AskedBackchannel reports whether a client sent the ONVIF backchannel Require header.
func (c *Camera) AskedBackchannel() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.asked
}

func (c *Camera) Close() { c.ln.Close() }

func (c *Camera) serve() {
	for {
		conn, err := c.ln.Accept()
		if err != nil {
			return
		}
		go c.handle(conn)
	}
}

func (c *Camera) sdp(backchannel bool) string {
	s := "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=Fake\r\nt=0 0\r\n" +
		"m=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\na=control:trackID=1\r\na=recvonly\r\n"
	if backchannel && c.Codec != "" {
		pt := 0
		if strings.HasPrefix(c.Codec, "PCMA") {
			pt = 8
		}
		s += fmt.Sprintf("m=audio 0 RTP/AVP %d\r\na=rtpmap:%d %s\r\na=control:trackID=3\r\na=sendonly\r\n", pt, pt, c.Codec)
	}
	return s
}

func (c *Camera) handle(conn net.Conn) {
	defer conn.Close()
	r := bufio.NewReader(conn)
	for {
		b, err := r.Peek(1)
		if err != nil {
			return
		}
		if b[0] == '$' {
			hdr := make([]byte, 4)
			if _, err := io.ReadFull(r, hdr); err != nil {
				return
			}
			buf := make([]byte, binary.BigEndian.Uint16(hdr[2:]))
			if _, err := io.ReadFull(r, buf); err != nil {
				return
			}
			var p rtp.Packet
			if hdr[1]&1 == 0 && p.Unmarshal(buf) == nil {
				select {
				case c.Packets <- &p:
				default:
				}
			}
			continue
		}
		method, headers, err := readRequest(r)
		if err != nil {
			return
		}
		cseq := headers["cseq"]
		reply := "RTSP/1.0 200 OK\r\nCSeq: " + cseq + "\r\n"
		switch method {
		case "OPTIONS":
			reply += "Public: OPTIONS, DESCRIBE, SETUP, PLAY, TEARDOWN\r\n\r\n"
		case "DESCRIBE":
			bc := strings.Contains(headers["require"], "www.onvif.org/ver20/backchannel")
			c.mu.Lock()
			c.asked = c.asked || bc
			c.mu.Unlock()
			body := c.sdp(bc)
			reply += "Content-Type: application/sdp\r\nContent-Length: " + strconv.Itoa(len(body)) + "\r\n\r\n" + body
		case "SETUP":
			reply += "Transport: " + headers["transport"] + "\r\nSession: 12345678;timeout=60\r\n\r\n"
		case "PLAY", "TEARDOWN":
			reply += "Session: 12345678\r\n\r\n"
		default:
			reply = "RTSP/1.0 405 Method Not Allowed\r\nCSeq: " + cseq + "\r\n\r\n"
		}
		if _, err := conn.Write([]byte(reply)); err != nil {
			return
		}
		if method == "TEARDOWN" {
			return
		}
	}
}

func readRequest(r *bufio.Reader) (string, map[string]string, error) {
	line, err := r.ReadString('\n')
	if err != nil {
		return "", nil, err
	}
	method, _, _ := strings.Cut(strings.TrimSpace(line), " ")
	headers := map[string]string{}
	for {
		l, err := r.ReadString('\n')
		if err != nil {
			return "", nil, err
		}
		l = strings.TrimSpace(l)
		if l == "" {
			break
		}
		k, v, _ := strings.Cut(l, ":")
		headers[strings.ToLower(strings.TrimSpace(k))] = strings.TrimSpace(v)
	}
	if n, _ := strconv.Atoi(headers["content-length"]); n > 0 {
		if _, err := io.CopyN(io.Discard, r, int64(n)); err != nil {
			return "", nil, err
		}
	}
	return method, headers, nil
}
