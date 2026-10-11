package unifi

import (
	"bytes"
	"compress/zlib"
	"context"
	"crypto/tls"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gorilla/websocket"

	"github.com/zachadams/sightline/bridge/backend"
)

// Real-time updates: wss://<console>/proxy/protect/ws/updates?lastUpdateId=<from bootstrap>.
// Every binary message is one update packet made of two frames, an action frame then a data
// frame. Each frame starts with an 8-byte header:
//
//	byte 0  packet type (1 = action, 2 = payload)
//	byte 1  payload format (1 = JSON, 2 = UTF-8 text, 3 = raw buffer)
//	byte 2  1 when the payload is zlib-deflated
//	byte 3  0
//	4..7    payload size, uint32 big-endian
//
// The action frame is JSON {"action":"add"|"update","newUpdateId","modelKey","id"}; for
// modelKey "event" the data frame is the event ("add") or the fields that changed ("update").

const (
	frameHeaderSize = 8
	formatJSON      = 1
	maxFramePayload = 16 << 20
)

type wsAction struct {
	Action      string `json:"action"`
	NewUpdateID string `json:"newUpdateId"`
	ModelKey    string `json:"modelKey"`
	ID          string `json:"id"`
}

type wsPacket struct {
	Action wsAction
	Data   []byte
	// DataFormat is the data frame's format (formatJSON for events).
	DataFormat byte
}

// readFrame splits one frame off b, inflating it when deflated.
func readFrame(b []byte) (payload []byte, format byte, rest []byte, err error) {
	if len(b) < frameHeaderSize {
		return nil, 0, nil, errors.New("short update frame")
	}
	size := binary.BigEndian.Uint32(b[4:8])
	if size > maxFramePayload || uint64(len(b)-frameHeaderSize) < uint64(size) {
		return nil, 0, nil, errors.New("truncated update frame")
	}
	format, deflated := b[1], b[2] == 1
	payload = b[frameHeaderSize : frameHeaderSize+int(size)]
	rest = b[frameHeaderSize+int(size):]
	if deflated {
		zr, err := zlib.NewReader(bytes.NewReader(payload))
		if err != nil {
			return nil, 0, nil, fmt.Errorf("update frame: %w", err)
		}
		defer zr.Close()
		payload, err = io.ReadAll(io.LimitReader(zr, maxFramePayload))
		if err != nil {
			return nil, 0, nil, fmt.Errorf("update frame: %w", err)
		}
	}
	return payload, format, rest, nil
}

// decodePacket parses one updates-websocket message.
func decodePacket(b []byte) (wsPacket, error) {
	var pkt wsPacket
	head, format, rest, err := readFrame(b)
	if err != nil {
		return pkt, err
	}
	if format != formatJSON {
		return pkt, errors.New("update action frame isn't JSON")
	}
	if err := json.Unmarshal(head, &pkt.Action); err != nil {
		return pkt, fmt.Errorf("update action frame: %w", err)
	}
	if len(rest) == 0 {
		return pkt, nil
	}
	pkt.Data, pkt.DataFormat, _, err = readFrame(rest)
	return pkt, err
}

// watcher turns update packets into events for a sink, remembering events in progress so
// partial updates (end time, more detections) can be merged.
type watcher struct {
	sink backend.Sink
	open map[string]*event
}

const maxOpenEvents = 1000

func (w *watcher) handle(pkt wsPacket) {
	if pkt.Action.ModelKey != "event" || pkt.DataFormat != formatJSON {
		return
	}
	var e event
	switch pkt.Action.Action {
	case "add":
		if err := json.Unmarshal(pkt.Data, &e); err != nil {
			return
		}
		if e.ID == "" {
			e.ID = pkt.Action.ID
		}
	case "update":
		prev, ok := w.open[pkt.Action.ID]
		if !ok {
			return // started before we connected; its camera is unknown
		}
		e = *prev
		if err := json.Unmarshal(pkt.Data, &e); err != nil {
			return
		}
		e.ID = pkt.Action.ID
	default:
		return
	}
	ev, ok := e.toEvent()
	if !ok {
		return
	}
	if ev.End != nil {
		delete(w.open, e.ID)
	} else {
		if len(w.open) >= maxOpenEvents {
			clear(w.open) // events that never ended; don't grow forever
		}
		w.open[e.ID] = &e
	}
	w.sink.OnEvent(ev)
}

// Watch streams Protect's updates to sink until ctx ends, reconnecting with backoff and
// signing in again when the session expires.
func (p *Protect) Watch(ctx context.Context, sink backend.Sink) error {
	w := &watcher{sink: sink, open: map[string]*event{}}
	backoff := time.Second
	for ctx.Err() == nil {
		began := time.Now()
		err := p.watchOnce(ctx, w)
		if ctx.Err() != nil {
			return nil
		}
		if time.Since(began) > time.Minute {
			backoff = time.Second
		}
		log.Printf("%s: UniFi Protect updates: %v (reconnecting in %s)", p.cfg.ID, err, backoff)
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, time.Minute)
	}
	return nil
}

var wsPingEvery = 30 * time.Second

func (p *Protect) updatesURL(lastUpdateID string) string {
	u := "ws" + strings.TrimPrefix(p.base, "http") + "/proxy/protect/ws/updates"
	if lastUpdateID != "" {
		u += "?lastUpdateId=" + url.QueryEscape(lastUpdateID)
	}
	return u
}

func (p *Protect) watchOnce(ctx context.Context, w *watcher) error {
	// A fresh bootstrap signs in when needed and gives the current lastUpdateId, so a
	// reconnect doesn't replay old alerts.
	b, err := p.bootstrap(ctx, true)
	if err != nil {
		return err
	}
	gen, _ := p.session()
	d := websocket.Dialer{
		HandshakeTimeout: 10 * time.Second,
		TLSClientConfig:  &tls.Config{InsecureSkipVerify: true}, //nolint:gosec // consoles use self-signed certificates
		ReadBufferSize:   64 << 10,
	}
	hdr := http.Header{}
	hdr.Set("Cookie", p.cookieHeader())
	conn, resp, err := d.DialContext(ctx, p.updatesURL(b.LastUpdateID), hdr)
	if err != nil {
		if resp != nil && resp.StatusCode == http.StatusUnauthorized {
			p.signOut(gen)
			return errors.New("signed out; signing in again")
		}
		return err
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	defer stop()

	deadline := func() { _ = conn.SetReadDeadline(time.Now().Add(3 * wsPingEvery)) }
	deadline()
	conn.SetPongHandler(func(string) error { deadline(); return nil })
	done := make(chan struct{})
	defer close(done)
	go func() {
		t := time.NewTicker(wsPingEvery)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-t.C:
				if conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second)) != nil {
					return
				}
			}
		}
	}()
	for {
		mt, msg, err := conn.ReadMessage()
		if err != nil {
			return err
		}
		deadline()
		if mt != websocket.BinaryMessage {
			continue
		}
		pkt, err := decodePacket(msg)
		if err != nil {
			continue
		}
		w.handle(pkt)
	}
}
