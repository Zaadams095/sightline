package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/AlexxIT/go2rtc/pkg/core"
	"github.com/AlexxIT/go2rtc/pkg/mp4"
	"github.com/gorilla/websocket"
	"github.com/pion/rtp"

	"github.com/zachadams/sightline/bridge/backend"
)

// ---- fMP4 made by go2rtc's own muxer (what both kinds of upstream send) ----

type testStream struct {
	m    *mp4.Muxer
	init []byte
	ts   uint32
}

func newTestStream(t *testing.T) *testStream {
	t.Helper()
	m := &mp4.Muxer{}
	m.AddTrack(&core.Codec{Name: core.CodecH264, ClockRate: 90000})
	m.AddTrack(&core.Codec{Name: core.CodecAAC, ClockRate: 16000, Channels: 1, FmtpLine: "config=1408"})
	init, err := m.GetInit()
	if err != nil {
		t.Fatal(err)
	}
	return &testStream{m: m, init: init}
}

// video is one H.264 access unit as one fragment: an IDR (keyframe) or a P-frame.
func (s *testStream) video(key bool, size int) []byte {
	nal := byte(0x41)
	if key {
		nal = 0x65
	}
	p := make([]byte, 4+1+size)
	binary.BigEndian.PutUint32(p, uint32(1+size))
	p[4] = nal
	s.ts += 3000
	return s.m.GetPayload(0, &rtp.Packet{Header: rtp.Header{Timestamp: s.ts}, Payload: p})
}

func (s *testStream) audio() []byte {
	return s.m.GetPayload(1, &rtp.Packet{Header: rtp.Header{Timestamp: s.ts}, Payload: []byte{1, 2, 3, 4}})
}

func TestFMP4KeyframeDetection(t *testing.T) {
	s := newTestStream(t)
	tr := parseMP4Init(s.init)
	if !tr.video[1] || tr.video[2] || len(tr.video) != 1 {
		t.Fatalf("video tracks = %v", tr.video)
	}
	if k := tr.classify(s.video(true, 100)); k != fragKey {
		t.Errorf("IDR fragment: %v", k)
	}
	if k := tr.classify(s.video(false, 100)); k != fragDelta {
		t.Errorf("P fragment: %v", k)
	}
	if k := tr.classify(s.audio()); k != fragOther {
		t.Errorf("audio fragment: %v", k)
	}

	// Init and fragments split apart, even when they arrive in one write.
	k, d := s.video(true, 10), s.video(false, 10)
	init, frags := splitFMP4(append(append(append([]byte{}, s.init...), k...), d...))
	if !bytes.Equal(init, s.init) || len(frags) != 2 || !bytes.Equal(frags[0], k) || !bytes.Equal(frags[1], d) {
		t.Fatalf("split: init %d bytes, %d fragments", len(init), len(frags))
	}

	// Other muxers put the flags in trun (first-sample flags or per-sample flags) or rely on
	// the trex defaults.
	box := func(typ string, parts ...[]byte) []byte {
		body := bytes.Join(parts, nil)
		b := make([]byte, 8, 8+len(body))
		binary.BigEndian.PutUint32(b, uint32(8+len(body)))
		copy(b[4:], typ)
		return append(b, body...)
	}
	u32 := func(v uint32) []byte { return binary.BigEndian.AppendUint32(nil, v) }
	tfhd := func(id uint32) []byte { return box("tfhd", u32(0), u32(id)) }
	frag := func(trun []byte) []byte {
		return box("moof", box("mfhd", u32(0), u32(1)), box("traf", tfhd(1), trun))
	}
	tr2 := mp4Tracks{video: map[uint32]bool{1: true}, defaultFlags: map[uint32]uint32{1: sampleIsNonSync}}
	if k := tr2.classify(frag(box("trun", u32(0x004), u32(1), u32(0x02000000)))); k != fragKey {
		t.Errorf("trun first-sample flags (sync): %v", k)
	}
	if k := tr2.classify(frag(box("trun", u32(0x400), u32(1), u32(0x01010000)))); k != fragDelta {
		t.Errorf("trun per-sample flags (non-sync): %v", k)
	}
	if k := tr2.classify(frag(box("trun", u32(0), u32(1)))); k != fragDelta {
		t.Errorf("trex default (non-sync): %v", k)
	}
	// Not ISO boxes at all, or an audio-only stream: never held back.
	if k := tr.classify([]byte("FRAG")); k != fragKey {
		t.Errorf("opaque data: %v", k)
	}
	if k := (mp4Tracks{}).classify(s.audio()); k != fragKey {
		t.Errorf("audio-only stream: %v", k)
	}
}

// ---- producers with a scripted upstream ----

type scriptedUpstream struct {
	mu      sync.Mutex
	starts  int
	feeds   []chan []byte // one per start; closing ends the stream
	failErr error         // returned at once when set
	codecs  []string
}

func (u *scriptedUpstream) fn(backend.LiveSource) liveUpstream {
	return func(ctx context.Context, codecs string, p *liveProducer) error {
		u.mu.Lock()
		u.starts++
		u.codecs = append(u.codecs, codecs)
		if u.failErr != nil {
			err := u.failErr
			u.mu.Unlock()
			return err
		}
		feed := make(chan []byte, 1024)
		u.feeds = append(u.feeds, feed)
		u.mu.Unlock()
		p.markConnected()
		p.setMime(`video/mp4; codecs="avc1.640029,mp4a.40.2"`)
		for {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case b, ok := <-feed:
				if !ok {
					return nil
				}
				if _, err := p.Write(b); err != nil {
					return err
				}
			}
		}
	}
}

func (u *scriptedUpstream) count() int {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.starts
}

func (u *scriptedUpstream) feed(t *testing.T, i int) chan []byte {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		u.mu.Lock()
		if len(u.feeds) > i {
			f := u.feeds[i]
			u.mu.Unlock()
			return f
		}
		u.mu.Unlock()
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("upstream %d never started", i)
	return nil
}

func testManager(grace time.Duration) (*liveManager, *scriptedUpstream) {
	lm := newLiveManager(grace)
	u := &scriptedUpstream{}
	lm.upstream = u.fn
	return lm, u
}

func openTest(t *testing.T, lm *liveManager, key string) (*liveProducer, bool) {
	t.Helper()
	p, created, err := lm.open(liveOpen{key: key, brand: "fake", codecs: "avc1.640029,mp4a.40.2",
		resolve: func(context.Context) (backend.LiveSource, error) {
			return backend.LiveSource{Kind: backend.LiveRTSP}, nil
		}})
	if err != nil {
		t.Fatal(err)
	}
	return p, created
}

func subscribeTest(t *testing.T, p *liveProducer) (*liveViewer, liveJoin) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	v, j, err := p.subscribe(ctx, "avc1.640029,mp4a.40.2")
	if err != nil {
		t.Fatal(err)
	}
	return v, j
}

// recv waits for the viewer's next write.
func recv(t *testing.T, v *liveViewer) []byte {
	t.Helper()
	select {
	case <-v.wake:
		return bytes.Join(v.take(), nil)
	case <-time.After(2 * time.Second):
		t.Fatal("no data")
		return nil
	}
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestGOPCacheStartsNewViewersAtKeyframe(t *testing.T) {
	lm, u := testManager(time.Minute)
	s := newTestStream(t)
	p, created := openTest(t, lm, "cam")
	if !created {
		t.Fatal("not created")
	}
	feed := u.feed(t, 0)
	d0 := s.video(false, 50) // before any keyframe: never cached
	k1, a1, d1 := s.video(true, 50), s.audio(), s.video(false, 50)
	feed <- s.init
	feed <- d0
	feed <- append(append(append([]byte{}, k1...), a1...), d1...) // several fragments in one write

	waitFor(t, "first GOP", func() bool { p.mu.Lock(); defer p.mu.Unlock(); return len(p.gop) == 3 })
	v1, j1 := subscribeTest(t, p)
	if !bytes.Equal(j1.init, s.init) {
		t.Error("init segment differs")
	}
	if want := bytes.Join([][]byte{k1, a1, d1}, nil); !bytes.Equal(j1.gop, want) {
		t.Fatalf("GOP = %d bytes, want %d (keyframe first, nothing before it)", len(j1.gop), len(want))
	}
	if j1.mime == "" || j1.times.Init == 0 || j1.times.Keyframe == 0 || j1.times.Connect == 0 {
		t.Errorf("join = mime %q times %+v", j1.mime, j1.times)
	}

	// Live fragments follow the cached ones.
	d2 := s.video(false, 50)
	feed <- d2
	if got := recv(t, v1); !bytes.Equal(got, d2) {
		t.Fatalf("viewer 1 got %d bytes", len(got))
	}

	// A new keyframe restarts the cache: the next viewer starts there.
	k2, d3 := s.video(true, 50), s.video(false, 50)
	feed <- k2
	feed <- d3
	waitFor(t, "second GOP", func() bool { p.mu.Lock(); defer p.mu.Unlock(); return len(p.gop) == 2 })
	_, j2 := subscribeTest(t, p)
	if want := append(append([]byte{}, k2...), d3...); !bytes.Equal(j2.gop, want) {
		t.Fatalf("second viewer GOP = %d bytes, want %d", len(j2.gop), len(want))
	}
	if got := recv(t, v1); !bytes.Equal(got, append(append([]byte{}, k2...), d3...)) && !bytes.Equal(got, k2) {
		t.Fatalf("viewer 1 missed the stream: %d bytes", len(got))
	}
	if u.count() != 1 {
		t.Errorf("upstream started %d times for two viewers", u.count())
	}
}

func TestGOPCacheIsBounded(t *testing.T) {
	lm, u := testManager(time.Minute)
	clock := time.Unix(1000, 0)
	var clockMu sync.Mutex
	lm.now = func() time.Time { clockMu.Lock(); defer clockMu.Unlock(); return clock }
	s := newTestStream(t)
	p, _ := openTest(t, lm, "cam")
	feed := u.feed(t, 0)
	feed <- s.init
	feed <- s.video(true, 1<<20)
	for i := 0; i < 8; i++ { // 9 MiB in total, over the 8 MiB bound
		feed <- s.video(false, 1<<20)
	}
	gopBytes := func() int { p.mu.Lock(); defer p.mu.Unlock(); return p.gopBytes }
	gopNil := func() bool { p.mu.Lock(); defer p.mu.Unlock(); return p.gop == nil && p.times.Keyframe != 0 }
	waitFor(t, "cache dropped by size", gopNil)
	if gopBytes() != 0 {
		t.Errorf("gopBytes = %d after drop", gopBytes())
	}

	// A viewer arriving now starts at the next keyframe; P-frames before it are skipped.
	v, j := subscribeTest(t, p)
	if j.gop != nil {
		t.Fatal("got a GOP without a keyframe")
	}
	feed <- s.video(false, 10)
	k := s.video(true, 10)
	feed <- k
	if got := recv(t, v); !bytes.Equal(got, k) {
		t.Fatalf("first data isn't the keyframe (%d bytes)", len(got))
	}

	// Too old: a camera with a very long keyframe interval stops being cached.
	waitFor(t, "small GOP", func() bool { return gopBytes() == len(k) })
	clockMu.Lock()
	clock = clock.Add(liveGOPMaxAge + time.Second)
	clockMu.Unlock()
	feed <- s.video(false, 10)
	waitFor(t, "cache dropped by age", gopNil)
}

func TestSharedProducerLifecycle(t *testing.T) {
	lm, u := testManager(150 * time.Millisecond)
	s := newTestStream(t)
	p, _ := openTest(t, lm, "cam")
	feed := u.feed(t, 0)
	feed <- s.init
	feed <- s.video(true, 10)
	waitFor(t, "a GOP", func() bool { p.mu.Lock(); defer p.mu.Unlock(); return p.gop != nil })

	v1, _ := subscribeTest(t, p)
	p2, created := openTest(t, lm, "cam")
	if created || p2 != p {
		t.Fatal("second viewer didn't share the stream")
	}
	v2, j2 := subscribeTest(t, p2)
	if j2.gop == nil {
		t.Error("second viewer got no cached picture")
	}
	if n, viewers := lm.counts(); n != 1 || viewers != 2 {
		t.Errorf("counts = %d streams, %d viewers", n, viewers)
	}

	// The last viewer leaving starts the grace period; reopening inside it is instant.
	p.release(v1)
	p.release(v2)
	time.Sleep(50 * time.Millisecond)
	p3, created := openTest(t, lm, "cam")
	if created || p3 != p {
		t.Fatal("stream wasn't kept warm")
	}
	v3, j3 := subscribeTest(t, p3)
	if j3.gop == nil {
		t.Error("warm reopen had no cached picture")
	}
	p.release(v3)
	waitFor(t, "grace period to end", func() bool { n, _ := lm.counts(); return n == 0 })
	if !p.isClosed() {
		t.Error("producer still open")
	}
	if _, created := openTest(t, lm, "cam"); !created {
		t.Error("closed stream was reused")
	}
	waitFor(t, "second upstream", func() bool { return u.count() == 2 })
}

func TestSharedProducerUpstreamError(t *testing.T) {
	lm, u := testManager(time.Minute)
	s := newTestStream(t)
	var noted atomic.Value
	p, _, err := lm.open(liveOpen{key: "cam", brand: "fake",
		resolve: func(context.Context) (backend.LiveSource, error) { return backend.LiveSource{}, nil },
		onErr:   func(err error) { noted.Store(err.Error()) }})
	if err != nil {
		t.Fatal(err)
	}
	feed := u.feed(t, 0)
	feed <- s.init
	feed <- s.video(true, 10)
	v1, _ := subscribeTest(t, p)
	v2, _ := subscribeTest(t, p)

	// The stream ending reaches every viewer, and the next viewer starts a new connection.
	close(feed)
	for _, v := range []*liveViewer{v1, v2} {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		err := v.run(ctx, func([][]byte) error { return nil })
		cancel()
		if !errors.Is(err, errStreamEnded) {
			t.Errorf("viewer error = %v", err)
		}
	}
	waitFor(t, "removal", func() bool { n, _ := lm.counts(); return n == 0 })

	// A failing camera: the error reaches the waiting viewer and the diagnostics hook.
	u.mu.Lock()
	u.failErr = errors.New("the camera rejected the username or password")
	u.mu.Unlock()
	p2, created, err := lm.open(liveOpen{key: "cam", brand: "fake",
		resolve: func(context.Context) (backend.LiveSource, error) { return backend.LiveSource{}, nil },
		onErr:   func(err error) { noted.Store(err.Error()) }})
	if err != nil || !created {
		t.Fatalf("dead stream reused (%v)", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, _, err := p2.subscribe(ctx, ""); err == nil || !strings.Contains(err.Error(), "password") {
		t.Fatalf("subscribe error = %v", err)
	}
	waitFor(t, "diagnostics note", func() bool { s, _ := noted.Load().(string); return strings.Contains(s, "password") })
}

func TestLiveViewerSlowQueueResumesAtKeyframe(t *testing.T) {
	v := &liveViewer{wake: make(chan struct{}, 1), done: make(chan struct{})}
	big := make([]byte, liveViewerMaxQueue/2+1)
	v.push(big, true)
	v.push(big, false) // over the bound: backlog dropped, wait for a keyframe
	v.push([]byte("delta"), false)
	if q := v.take(); len(q) != 0 || v.droppedCount() != 1 {
		t.Fatalf("queue after overflow = %d items, dropped %d", len(q), v.droppedCount())
	}
	v.push([]byte("key"), true)
	v.push([]byte("delta"), false)
	if q := v.take(); len(q) != 2 || string(q[0]) != "key" {
		t.Fatalf("resumed queue = %q", q)
	}
}

func TestCodecsCompatible(t *testing.T) {
	for _, c := range []struct {
		produced, viewer string
		want             bool
	}{
		{"avc1.4D401F,mp4a.40.2", "avc1.640029,hvc1.1.6.L153.B0,mp4a.40.2", true},
		{"hvc1.1.6.L153.B0", "avc1.640029,mp4a.40.2", false},
		{"avc1.640029,flac", "avc1.640029,mp4a.40.2", false},
		{"avc1.640029,flac", liveDefaultCodecs, true},
		{"avc1.640029,mp4a.40.2", "", true},
	} {
		if got := codecsCompatible(c.produced, c.viewer); got != c.want {
			t.Errorf("compatible(%q, %q) = %v", c.produced, c.viewer, got)
		}
	}
	if !moreAudio(liveDefaultCodecs, hlsCodecs) || moreAudio(hlsCodecs, liveDefaultCodecs) {
		t.Error("moreAudio")
	}

	// A stream that left out the camera's audio (opened by the TV, which can't take FLAC) isn't
	// shared with a phone that could have had it.
	lm, u := testManager(time.Minute)
	s := newTestStream(t)
	p, _, err := lm.open(liveOpen{key: "cam", codecs: hlsCodecs,
		resolve: func(context.Context) (backend.LiveSource, error) { return backend.LiveSource{}, nil }})
	if err != nil {
		t.Fatal(err)
	}
	feed := u.feed(t, 0)
	p.setDroppedAudio()
	feed <- s.init
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, _, err := p.subscribe(ctx, liveDefaultCodecs); !errors.Is(err, errIncompatible) {
		t.Errorf("phone joined a stream without its audio: %v", err)
	}
	if _, _, err := p.subscribe(ctx, hlsCodecs); err != nil {
		t.Errorf("same-codec viewer: %v", err)
	}
}

// ---- through the Hub's routes ----

// fakeGo2RTC is an upstream speaking go2rtc's MSE protocol with real fMP4: init, a keyframe,
// then P-frames every 20 ms (a keyframe every 10).
func fakeGo2RTC(t *testing.T) (url string, dials *atomic.Int32) {
	t.Helper()
	dials = &atomic.Int32{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		dials.Add(1)
		var m wsMessage
		if ws.ReadJSON(&m) != nil || m.Type != "mse" {
			return
		}
		s := newTestStream(t)
		_ = ws.WriteJSON(wsMessage{Type: "mse", Value: `video/mp4; codecs="avc1.640029,mp4a.40.2"`})
		_ = ws.WriteMessage(websocket.BinaryMessage, s.init)
		for i := 0; i < 500; i++ {
			if ws.WriteMessage(websocket.BinaryMessage, s.video(i%10 == 0, 200)) != nil {
				return
			}
			time.Sleep(20 * time.Millisecond)
		}
	}))
	t.Cleanup(srv.Close)
	return "ws" + strings.TrimPrefix(srv.URL, "http") + "/live/mse/api/ws", dials
}

func TestLiveSharedOverWebSocket(t *testing.T) {
	th := newTestHub(t)
	up, dials := fakeGo2RTC(t)
	th.primary.liveURL = up
	tracks := parseMP4Init(newTestStream(t).init)

	base := "ws" + strings.TrimPrefix(th.srv.URL, "http") + "/v1/cameras/front/live?token="
	// New-style: codecs in the URL, no message needed; the mime and media arrive at once.
	c1, _, err := websocket.DefaultDialer.Dial(base+th.tokens[roleLive]+"&codecs=avc1.640029,mp4a.40.2", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c1.Close()
	var m wsMessage
	if err := c1.ReadJSON(&m); err != nil || m.Type != "mse" || !strings.Contains(m.Value, "avc1") {
		t.Fatalf("mse = %+v %v", m, err)
	}
	mt, b, err := c1.ReadMessage()
	if err != nil || mt != websocket.BinaryMessage {
		t.Fatalf("first binary: %v %v", mt, err)
	}
	if init, _ := splitFMP4(b); init == nil {
		t.Fatal("first binary has no init segment")
	}
	if err := c1.ReadJSON(&m); err != nil || m.Type != "hub" || !strings.Contains(m.Value, `"start":"cold"`) {
		t.Fatalf("hub hello = %+v %v", m, err)
	}

	// Let a GOP build up, then a second viewer (old-style handshake) joins the same stream and
	// gets init + a keyframe in its first binary message.
	time.Sleep(300 * time.Millisecond)
	c2, _, err := websocket.DefaultDialer.Dial(base+th.tokens[roleOwner], nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c2.Close()
	_ = c2.WriteJSON(wsMessage{Type: "mse", Value: "avc1.640029,mp4a.40.2"})
	if err := c2.ReadJSON(&m); err != nil || m.Type != "mse" {
		t.Fatalf("viewer 2 mse = %+v %v", m, err)
	}
	_, b, err = c2.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	init, frags := splitFMP4(b)
	if init == nil || len(frags) == 0 || tracks.classify(frags[0]) != fragKey {
		t.Fatalf("viewer 2 first message: init=%v, %d fragments", init != nil, len(frags))
	}
	if err := c2.ReadJSON(&m); err != nil || !strings.Contains(m.Value, `"start":"gop"`) {
		t.Fatalf("viewer 2 hello = %+v %v", m, err)
	}
	if n := dials.Load(); n != 1 {
		t.Errorf("upstream dialed %d times for two viewers", n)
	}

	// A player that can't play the shared stream's codecs gets its own.
	c3, _, err := websocket.DefaultDialer.Dial(base+th.tokens[roleOwner]+"&codecs=hvc1.1.6.L153.B0", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c3.Close()
	if err := c3.ReadJSON(&m); err != nil || m.Type != "mse" {
		t.Fatalf("viewer 3 mse = %+v %v", m, err)
	}
	_, _, _ = c3.ReadMessage()
	if err := c3.ReadJSON(&m); err != nil || !strings.Contains(m.Value, `"start":"dedicated"`) {
		t.Fatalf("viewer 3 hello = %+v %v", m, err)
	}
	if n := dials.Load(); n != 2 {
		t.Errorf("upstream dialed %d times, want 2", n)
	}

	// Sessions show up in the owner's diagnostics once they end.
	c1.Close()
	c2.Close()
	c3.Close()
	waitFor(t, "sessions recorded", func() bool { l, _ := th.h.liveStats.snapshot(); return len(l) == 3 })
	var diag struct {
		Live struct {
			Sessions []liveSessionStat `json:"sessions"`
			Summary  liveStatsSummary  `json:"summary"`
		} `json:"live"`
	}
	th.call(t, th.tokens[roleOwner], "GET", "/v1/diagnostics", nil, 200, &diag)
	if len(diag.Live.Sessions) != 3 || diag.Live.Summary.Starts["gop"] != 1 || diag.Live.Summary.LAN.MedianFirstFrameMs == 0 {
		t.Fatalf("diagnostics live = %+v", diag.Live)
	}
	for _, s := range diag.Live.Sessions {
		if s.Brand != "fake" || s.FirstByteMs == 0 || s.Via != "lan" {
			t.Errorf("session = %+v", s)
		}
	}
}

func TestLiveWarm(t *testing.T) {
	th := newTestHub(t)
	up, dials := fakeGo2RTC(t)
	th.primary.liveURL = up
	warm := func(token, cam string) (int, map[string]any) {
		t.Helper()
		resp := th.do(t, token, "POST", "/v1/cameras/"+cam+"/warm?quality=sub", nil)
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out
	}
	if code, out := warm(th.tokens[roleLive], "front"); code != 202 || out["state"] != "starting" {
		t.Fatalf("warm = %d %v", code, out)
	}
	waitFor(t, "upstream dial", func() bool { return dials.Load() == 1 })
	if code, out := warm(th.tokens[roleOwner], "front"); code != 202 || out["state"] != "warm" {
		t.Fatalf("second warm = %d %v", code, out)
	}
	// Grant-checked like live view.
	if code, _ := warm(th.tokens[roleLive], "back"); code != 404 {
		t.Errorf("camera outside the grant: %d", code)
	}
	if code, _ := warm("", "front"); code != 401 {
		t.Errorf("no token: %d", code)
	}
	// The viewer that follows joins the warm stream and starts with a picture.
	time.Sleep(300 * time.Millisecond)
	c, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(th.srv.URL, "http")+"/v1/cameras/front/live?quality=sub&codecs=avc1.640029,mp4a.40.2&token="+th.tokens[roleLive], nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	var m wsMessage
	_ = c.ReadJSON(&m)
	_, _, _ = c.ReadMessage()
	if err := c.ReadJSON(&m); err != nil || !strings.Contains(m.Value, `"start":"gop"`) {
		t.Fatalf("hello after warm = %+v %v", m, err)
	}
	if n := dials.Load(); n != 1 {
		t.Errorf("upstream dialed %d times", n)
	}
	// Rate-limited per grant.
	limited := false
	for i := 0; i < 40 && !limited; i++ {
		code, _ := warm(th.tokens[roleFull], "front")
		limited = code == http.StatusTooManyRequests
	}
	if !limited {
		t.Error("warm-ups were never rate-limited")
	}
	if code, _ := warm(th.tokens[roleHousehold], "front"); code != 202 {
		t.Errorf("another grant was limited too: %d", code)
	}
}

func TestLiveQualityForRemoteRequests(t *testing.T) {
	req := func(remote bool, q string) *http.Request {
		r := httptest.NewRequest("GET", "/v1/cameras/front/live?quality="+q, nil)
		if remote {
			r = r.WithContext(context.WithValue(r.Context(), keyRemote, true))
		}
		return r
	}
	for _, c := range []struct {
		remote bool
		q      string
		want   string
	}{
		{false, "", "main"}, {false, "main", "main"}, {false, "sub", "sub"},
		{true, "", "sub"}, {true, "sub", "sub"}, {true, "main", "main"}, {true, "hd", "sub"},
	} {
		if got := liveQuality(req(c.remote, c.q)); got != c.want {
			t.Errorf("remote=%v quality=%q → %q, want %q", c.remote, c.q, got, c.want)
		}
	}

	// End to end: a warm-up through the remote listener asks the backend for its sub stream.
	th := newTestHub(t)
	th.h.live.upstream = (&scriptedUpstream{}).fn
	remote := httptest.NewServer(th.h.remoteHandler(th.h.lanHandler))
	defer remote.Close()
	r, _ := http.NewRequest("POST", remote.URL+"/v1/cameras/front/warm", nil)
	r.Header.Set("Authorization", "Bearer "+th.tokens[roleOwner])
	resp, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	waitFor(t, "backend asked for the sub stream", func() bool {
		th.primary.mu.Lock()
		defer th.primary.mu.Unlock()
		for _, c := range th.primary.calls {
			if c == "live front sub" {
				return true
			}
		}
		return false
	})
}

func TestParseGrace(t *testing.T) {
	for in, want := range map[string]time.Duration{"": 0, "90": 90 * time.Second, "2m": 2 * time.Minute, "0": -1, "off": -1, "junk": 0} {
		if got := parseGrace(in); got != want {
			t.Errorf("parseGrace(%q) = %v, want %v", in, got, want)
		}
	}
}
