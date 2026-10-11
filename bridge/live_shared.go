package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/AlexxIT/go2rtc/pkg/core"
	"github.com/AlexxIT/go2rtc/pkg/mp4"
	"github.com/gorilla/websocket"

	"github.com/zachadams/sightline/bridge/backend"
)

// Shared live streams. Every viewer of a camera (phones on the MSE WebSocket, the TV on HLS)
// shares one upstream connection per camera and quality: a "producer". A producer
//
//   - keeps the init segment and every fragment since the last keyframe (the GOP cache), so a
//     new viewer gets a decodable picture at once instead of waiting for the camera's next
//     keyframe (often 2–10 s);
//   - stays connected for a grace period after its last viewer leaves (LIVE_GRACE, default
//     60 s), so reopening a camera or switching back is instant;
//   - can be started before anyone watches (POST /v1/cameras/{id}/warm, when a finger lands on
//     a tile).
//
// Both kinds of upstream end up as the same fMP4 byte stream: RTSP sources are restreamed with
// go2rtc's pkg/rtsp + pkg/mp4, and go2rtc MSE WebSockets (Frigate) already speak it. So the
// cache works on fMP4 boxes (fmp4.go), one code path for every brand. Frigate stays on its
// MSE WebSocket rather than its RTSP restream (port 8554): that is the route already known to
// work through Frigate's own port 5000, it needs no RTSP credentials or extra port, and
// Frigate's go2rtc keeps doing any audio/codec handling the user configured there.
//
// A producer is opened with the first viewer's codecs. A later viewer joins only if it can
// play every codec the producer sends; otherwise it gets a dedicated producer of its own.

const (
	liveDefaultGrace   = 60 * time.Second
	liveStartWait      = 15 * time.Second
	liveResolveTimeout = 15 * time.Second
	liveMaxProducers   = 48
	// The GOP cache is dropped (until the next keyframe) past either bound, so a camera with a
	// huge keyframe interval can't make the Hub hold much.
	liveGOPMaxBytes = 8 << 20
	liveGOPMaxAge   = 20 * time.Second
	// A viewer that can't keep up loses its backlog and resumes at the next keyframe.
	liveViewerMaxQueue = 8 << 20
	liveWriteTimeout   = 20 * time.Second
	// What the app's player asks for on an iPhone; used to warm a stream before the player
	// says what it supports.
	liveDefaultCodecs = "avc1.640029,avc1.64002A,avc1.640033,hvc1.1.6.L153.B0,mp4a.40.2,mp4a.40.5,flac,opus"
)

var (
	errLiveBusy     = errors.New("too many live streams are open on the Hub right now")
	errStreamEnded  = errors.New("the camera's stream ended")
	errNoVideo      = errors.New("the camera didn't send any video")
	errLiveStopped  = errors.New("live stream stopped")
	errIncompatible = errors.New("this player can't play the stream's format")
)

// liveUpstream feeds a producer until the stream ends or ctx is cancelled: it reports the
// connection and content type, then writes the fMP4 stream (init segment first) to p.
type liveUpstream func(ctx context.Context, codecs string, p *liveProducer) error

type liveManager struct {
	grace time.Duration
	max   int
	base  context.Context
	now   func() time.Time
	// upstream picks how to read a source (tests replace it).
	upstream func(backend.LiveSource) liveUpstream

	mu     sync.Mutex
	shared map[string]*liveProducer
	all    map[*liveProducer]struct{}
}

func newLiveManager(grace time.Duration) *liveManager {
	return &liveManager{
		grace: grace, max: liveMaxProducers, base: context.Background(), now: time.Now,
		upstream: defaultLiveUpstream,
		shared:   map[string]*liveProducer{}, all: map[*liveProducer]struct{}{},
	}
}

func defaultLiveUpstream(src backend.LiveSource) liveUpstream {
	switch src.Kind {
	case backend.LiveRTSP:
		return rtspUpstream(src.URL)
	case backend.LiveMSE:
		return mseUpstream(src.URL)
	}
	return func(context.Context, string, *liveProducer) error { return errors.New("unsupported live source") }
}

// liveOpen describes a producer to find or start.
type liveOpen struct {
	key     string // "" = dedicated (never shared)
	brand   string
	codecs  string
	resolve func(ctx context.Context) (backend.LiveSource, error)
	onErr   func(error)
}

// open returns the running shared producer for o.key, or starts one. created reports a start.
func (lm *liveManager) open(o liveOpen) (p *liveProducer, created bool, err error) {
	var evict *liveProducer
	lm.mu.Lock()
	if o.key != "" {
		if p := lm.shared[o.key]; p != nil && !p.isClosed() {
			lm.mu.Unlock()
			return p, false, nil
		}
	}
	if len(lm.all) >= lm.max {
		// Make room by closing the stream that has been idle (kept warm) the longest.
		var evictAt time.Time
		for q := range lm.all {
			if idle, since := q.idleSince(); idle && (evict == nil || since.Before(evictAt)) {
				evict, evictAt = q, since
			}
		}
		if evict == nil {
			lm.mu.Unlock()
			return nil, false, errLiveBusy
		}
		delete(lm.all, evict)
		if lm.shared[evict.key] == evict {
			delete(lm.shared, evict.key)
		}
	}
	ctx, cancel := context.WithCancel(lm.base)
	p = &liveProducer{
		lm: lm, key: o.key, brand: o.brand, codecs: o.codecs, onErr: o.onErr,
		started: lm.now(), cancel: cancel, ready: make(chan struct{}),
		viewers: map[*liveViewer]struct{}{},
	}
	if o.codecs == "" {
		p.codecs = liveDefaultCodecs
	}
	// Nobody may ever join (a warm-up, or a viewer that gave up): close it after the grace
	// period (dedicated ones once the start wait is over).
	p.mu.Lock()
	p.armIdleLocked(p.idleAfter(true))
	p.mu.Unlock()
	lm.all[p] = struct{}{}
	if o.key != "" {
		lm.shared[o.key] = p
	}
	lm.mu.Unlock()
	if evict != nil {
		evict.fail(errLiveStopped)
	}
	go p.run(ctx, o.resolve)
	return p, true, nil
}

func (lm *liveManager) remove(p *liveProducer) {
	lm.mu.Lock()
	defer lm.mu.Unlock()
	delete(lm.all, p)
	if p.key != "" && lm.shared[p.key] == p {
		delete(lm.shared, p.key)
	}
}

// closeAll stops every stream (the systems were reconfigured).
func (lm *liveManager) closeAll() {
	lm.mu.Lock()
	ps := make([]*liveProducer, 0, len(lm.all))
	for p := range lm.all {
		ps = append(ps, p)
	}
	lm.mu.Unlock()
	for _, p := range ps {
		p.fail(errLiveStopped)
	}
}

// counts reports running producers and their viewers.
func (lm *liveManager) counts() (producers, viewers int) {
	lm.mu.Lock()
	ps := make([]*liveProducer, 0, len(lm.all))
	for p := range lm.all {
		ps = append(ps, p)
	}
	lm.mu.Unlock()
	for _, p := range ps {
		p.mu.Lock()
		viewers += len(p.viewers)
		p.mu.Unlock()
	}
	return len(ps), viewers
}

// liveTimes are milestones of a producer, measured from its start (0 = not reached).
type liveTimes struct {
	Connect  time.Duration // upstream connected (RTSP DESCRIBE answered / WebSocket open)
	Codecs   time.Duration // content type known
	Init     time.Duration // init segment arrived
	Keyframe time.Duration // first keyframe fragment arrived
}

type liveProducer struct {
	lm      *liveManager
	key     string
	brand   string
	codecs  string
	onErr   func(error)
	started time.Time
	cancel  context.CancelFunc

	ready     chan struct{} // closed once the init segment arrived or the stream failed
	readyOnce sync.Once

	mu       sync.Mutex
	mime     string
	init     []byte
	tracks   mp4Tracks
	gop      [][]byte
	gopBytes int
	gopAt    time.Time
	viewers  map[*liveViewer]struct{}
	err      error
	closed   bool
	idleGen  int
	idle     *time.Timer
	idleAt   time.Time // when the last viewer left (zero while watched)
	times    liveTimes
	bytesIn  int64
	// droppedAudio: the camera has audio this stream's codecs couldn't carry.
	droppedAudio bool
}

func (p *liveProducer) isClosed() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.closed
}

func (p *liveProducer) idleSince() (bool, time.Time) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.viewers) == 0 && !p.closed, p.idleAt
}

func (p *liveProducer) since() time.Duration {
	d := p.lm.now().Sub(p.started)
	if d <= 0 {
		d = time.Nanosecond // "reached", even on a coarse clock
	}
	return d
}

func (p *liveProducer) markConnected() {
	p.mu.Lock()
	if p.times.Connect == 0 {
		p.times.Connect = p.since()
	}
	p.mu.Unlock()
}

func (p *liveProducer) setMime(m string) {
	p.mu.Lock()
	p.mime = m
	if p.times.Codecs == 0 {
		p.times.Codecs = p.since()
	}
	p.mu.Unlock()
}

func (p *liveProducer) markReady() { p.readyOnce.Do(func() { close(p.ready) }) }

// Write takes the upstream's fMP4 stream: the init segment, then fragments.
func (p *liveProducer) Write(b []byte) (int, error) {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return 0, errLiveStopped
	}
	data := append([]byte(nil), b...)
	p.bytesIn += int64(len(b))
	init, frags := splitFMP4(data)
	if p.init == nil && init == nil && len(frags) > 0 {
		// go2rtc's protocol: the first binary message is the init segment, whatever it holds.
		init, frags = frags[0], frags[1:]
	}
	readyNow := false
	if init != nil {
		if p.init != nil {
			// A new init segment mid-stream (the format changed): viewers must start over.
			p.mu.Unlock()
			p.fail(errStreamEnded)
			return 0, errStreamEnded
		}
		p.init, p.tracks = init, parseMP4Init(init)
		p.times.Init = p.since()
		readyNow = true
	}
	now := p.lm.now()
	for _, f := range frags {
		if p.init == nil {
			continue // nothing can play without the init segment
		}
		key := p.tracks.classify(f) == fragKey
		if key {
			if p.times.Keyframe == 0 {
				p.times.Keyframe = p.since()
			}
			p.gop, p.gopBytes, p.gopAt = [][]byte{f}, len(f), now
		} else if p.gop != nil {
			if p.gopBytes+len(f) > liveGOPMaxBytes || now.Sub(p.gopAt) > liveGOPMaxAge {
				p.gop, p.gopBytes = nil, 0
			} else {
				p.gop = append(p.gop, f)
				p.gopBytes += len(f)
			}
		}
		for v := range p.viewers {
			v.push(f, key)
		}
	}
	p.mu.Unlock()
	if readyNow {
		p.markReady()
	}
	return len(b), nil
}

// fail ends the producer: viewers get err, the upstream is closed.
func (p *liveProducer) fail(err error) {
	p.mu.Lock()
	first := !p.closed
	if first {
		p.closed = true
		p.err = err
		for v := range p.viewers {
			v.end(err)
		}
		p.viewers = map[*liveViewer]struct{}{}
		if p.idle != nil {
			p.idle.Stop()
		}
		p.gop, p.init = nil, nil
	}
	p.mu.Unlock()
	if !first {
		return
	}
	p.markReady()
	p.lm.remove(p)
	p.cancel()
	if p.onErr != nil && !errors.Is(err, errLiveStopped) && !errors.Is(err, context.Canceled) && !errors.Is(err, errStreamEnded) {
		p.onErr(err)
	}
}

func (p *liveProducer) run(ctx context.Context, resolve func(context.Context) (backend.LiveSource, error)) {
	rctx, cancel := context.WithTimeout(ctx, liveResolveTimeout)
	src, err := resolve(rctx)
	cancel()
	if err != nil {
		p.fail(err)
		return
	}
	err = p.lm.upstream(src)(ctx, p.codecs, p)
	if err == nil || ctx.Err() != nil {
		err = errStreamEnded
	}
	p.fail(err)
}

// idleAfter is how long the producer lives without viewers.
func (p *liveProducer) idleAfter(starting bool) time.Duration {
	if p.key == "" {
		if starting {
			return liveStartWait + 5*time.Second
		}
		return 0
	}
	if starting && p.lm.grace < liveStartWait+5*time.Second {
		// Give a viewer that is on its way time to arrive even with a short grace period.
		return liveStartWait + 5*time.Second
	}
	return p.lm.grace
}

func (p *liveProducer) armIdleLocked(d time.Duration) {
	p.idleGen++
	gen := p.idleGen
	p.idleAt = p.lm.now()
	if p.idle != nil {
		p.idle.Stop()
	}
	p.idle = time.AfterFunc(d, func() { p.idleExpired(gen) })
}

func (p *liveProducer) idleExpired(gen int) {
	p.mu.Lock()
	stale := gen != p.idleGen || len(p.viewers) > 0 || p.closed
	p.mu.Unlock()
	if !stale {
		p.fail(errLiveStopped)
	}
}

// warm keeps an unwatched producer alive for another grace period.
func (p *liveProducer) warm() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.viewers) == 0 && !p.closed {
		p.armIdleLocked(p.lm.grace)
	}
}

// liveJoin is what a new viewer starts with.
type liveJoin struct {
	mime string
	init []byte
	// gop is every fragment since the last keyframe ("" when no keyframe is cached: the viewer
	// then starts at the next one).
	gop   []byte
	times liveTimes
}

// subscribe waits for the stream to be ready and adds a viewer that can play codecs.
func (p *liveProducer) subscribe(ctx context.Context, codecs string) (*liveViewer, liveJoin, error) {
	t := time.NewTimer(liveStartWait)
	defer t.Stop()
	select {
	case <-p.ready:
	case <-ctx.Done():
		return nil, liveJoin{}, ctx.Err()
	case <-t.C:
		return nil, liveJoin{}, errNoVideo
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		if p.err != nil && !errors.Is(p.err, errLiveStopped) {
			return nil, liveJoin{}, p.err
		}
		return nil, liveJoin{}, errStreamEnded
	}
	// A dedicated stream was negotiated with this player's own codecs: it gets what the
	// upstream chose, as with a direct connection.
	if p.key != "" && (!codecsCompatible(codecsFromMime(p.mime), codecs) ||
		(p.droppedAudio && moreAudio(codecs, p.codecs))) {
		// Can't play it, or the stream left out the camera's audio and this player could
		// have it (e.g. G.711 sent as FLAC): a stream of its own.
		return nil, liveJoin{}, errIncompatible
	}
	v := &liveViewer{wake: make(chan struct{}, 1), done: make(chan struct{})}
	j := liveJoin{mime: p.mime, init: p.init, times: p.times}
	if p.gop != nil {
		j.gop = make([]byte, 0, p.gopBytes)
		for _, f := range p.gop {
			j.gop = append(j.gop, f...)
		}
	} else {
		v.waitKey = true
	}
	p.viewers[v] = struct{}{}
	p.idleGen++ // cancels a pending idle close
	if p.idle != nil {
		p.idle.Stop()
	}
	p.idleAt = time.Time{}
	return v, j, nil
}

// release removes a viewer; the last one out starts the grace period.
func (p *liveProducer) release(v *liveViewer) {
	p.mu.Lock()
	if _, ok := p.viewers[v]; !ok {
		p.mu.Unlock()
		return
	}
	delete(p.viewers, v)
	stopNow := false
	if len(p.viewers) == 0 && !p.closed {
		if d := p.idleAfter(false); d > 0 {
			p.armIdleLocked(d)
		} else {
			stopNow = true
		}
	}
	p.mu.Unlock()
	if stopNow {
		p.fail(errLiveStopped)
	}
}

// liveViewer is one viewer's queue of fragments.
type liveViewer struct {
	mu      sync.Mutex
	q       [][]byte
	qBytes  int
	waitKey bool
	dropped int
	wake    chan struct{} // signalled when q grows
	done    chan struct{} // closed when the producer ends
	err     error
}

func (v *liveViewer) push(f []byte, key bool) {
	v.mu.Lock()
	if v.waitKey {
		if !key {
			v.mu.Unlock()
			return
		}
		v.waitKey = false
	}
	if v.qBytes+len(f) > liveViewerMaxQueue {
		v.q, v.qBytes = nil, 0
		v.dropped++
		if !key {
			v.waitKey = true
			v.mu.Unlock()
			return
		}
	}
	v.q = append(v.q, f)
	v.qBytes += len(f)
	v.mu.Unlock()
	select {
	case v.wake <- struct{}{}:
	default:
	}
}

func (v *liveViewer) take() [][]byte {
	v.mu.Lock()
	defer v.mu.Unlock()
	q := v.q
	v.q, v.qBytes = nil, 0
	return q
}

func (v *liveViewer) end(err error) {
	v.mu.Lock()
	v.err = err
	v.mu.Unlock()
	close(v.done)
}

// run hands everything queued to write, one call per wake-up (several fragments coalesce into
// one write when the network is slower than the camera, never waiting for more), until the
// stream ends (its error) or ctx ends.
func (v *liveViewer) run(ctx context.Context, write func([][]byte) error) error {
	for {
		select {
		case <-v.wake:
			if q := v.take(); len(q) > 0 {
				if err := write(q); err != nil {
					return err
				}
			}
		case <-v.done:
			if q := v.take(); len(q) > 0 {
				_ = write(q)
			}
			v.mu.Lock()
			defer v.mu.Unlock()
			return v.err
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

func (v *liveViewer) droppedCount() int {
	v.mu.Lock()
	defer v.mu.Unlock()
	return v.dropped
}

// ---- codec families ----

// codecFamily maps an MSE codec string to what it means for a decoder.
func codecFamily(c string) string {
	c = strings.ToLower(strings.TrimSpace(c))
	switch {
	case strings.HasPrefix(c, "avc1"), strings.HasPrefix(c, "avc3"):
		return "h264"
	case strings.HasPrefix(c, "hvc1"), strings.HasPrefix(c, "hev1"):
		return "h265"
	case strings.HasPrefix(c, "mp4a"):
		return "aac"
	}
	return c
}

func codecFamilies(list string) map[string]bool {
	out := map[string]bool{}
	for _, c := range strings.Split(list, ",") {
		if f := codecFamily(c); f != "" {
			out[f] = true
		}
	}
	return out
}

// codecsCompatible: can a player that supports viewer play a stream of produced? An empty
// viewer list means go2rtc's default (H.264, H.265, AAC).
func codecsCompatible(produced, viewer string) bool {
	if strings.TrimSpace(viewer) == "" {
		viewer = "avc1,hvc1,mp4a"
	}
	can := codecFamilies(viewer)
	for f := range codecFamilies(produced) {
		if !can[f] {
			return false
		}
	}
	return true
}

// moreAudio: does viewer accept an audio codec that requested didn't ask for?
func moreAudio(viewer, requested string) bool {
	if strings.TrimSpace(viewer) == "" {
		viewer = "mp4a"
	}
	asked := codecFamilies(requested)
	for f := range codecFamilies(viewer) {
		if (f == "aac" || f == "flac" || f == "opus") && !asked[f] {
			return true
		}
	}
	return false
}

func (p *liveProducer) setDroppedAudio() {
	p.mu.Lock()
	p.droppedAudio = true
	p.mu.Unlock()
}

// ---- upstreams ----

// rtspUpstream restreams an RTSP source to fMP4 with go2rtc's packages.
func rtspUpstream(rawURL string) liveUpstream {
	return func(ctx context.Context, codecs string, p *liveProducer) error {
		cons, prod, err := startMSE(rawURL, codecs)
		if err != nil {
			return err
		}
		if ctx.Err() != nil {
			_ = prod.Stop()
			return ctx.Err()
		}
		p.markConnected()
		p.setMime(mp4.ContentType(cons.Codecs()))
		if hasAudio(prod.GetMedias()) && !slices.ContainsFunc(cons.Codecs(), (*core.Codec).IsAudio) {
			p.setDroppedAudio()
		}
		stop := context.AfterFunc(ctx, func() {
			_ = prod.Stop()
			_ = cons.Stop()
		})
		defer stop()
		go func() {
			_, _ = cons.WriteTo(p)
			_ = prod.Stop() // the producer closed: stop reading the camera
		}()
		if err := prod.Start(); err != nil && ctx.Err() == nil {
			return friendlyRTSPError(err)
		}
		_ = cons.Stop()
		return errStreamEnded
	}
}

func hasAudio(medias []*core.Media) bool {
	for _, m := range medias {
		if m.Kind == core.KindAudio && m.Direction == core.DirectionRecvonly {
			return true
		}
	}
	return false
}

// mseUpstream reads a go2rtc MSE WebSocket (Frigate's built-in go2rtc).
func mseUpstream(rawURL string) liveUpstream {
	return func(ctx context.Context, codecs string, p *liveProducer) error {
		d := websocket.Dialer{HandshakeTimeout: 10 * time.Second, ReadBufferSize: 64 << 10, WriteBufferSize: 1024}
		up, _, err := d.DialContext(ctx, rawURL, nil)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return errors.New("could not reach the camera's live stream")
		}
		defer up.Close()
		stop := context.AfterFunc(ctx, func() { _ = up.Close() })
		defer stop()
		p.markConnected()
		if err := up.WriteJSON(wsMessage{Type: "mse", Value: codecs}); err != nil {
			return err
		}
		for {
			mt, b, err := up.ReadMessage()
			if err != nil {
				return errStreamEnded
			}
			if mt == websocket.TextMessage {
				var m wsMessage
				_ = json.Unmarshal(b, &m)
				switch m.Type {
				case "mse":
					p.setMime(m.Value)
				case "error":
					return errors.New(m.Value)
				}
				continue
			}
			if _, err := p.Write(b); err != nil {
				return err
			}
		}
	}
}

// ---- joining from the Hub's routes ----

// liveKey identifies a shareable stream: one system's camera at one quality.
func liveKey(s *system, native, quality string) string {
	return s.cfg.ID + "\x00" + native + "\x00" + quality
}

// joinLive finds or starts the camera's shared stream and adds a viewer that plays codecs.
// start says how warm the stream was: "gop" (a picture at once), "warm" (connected, waiting
// for a keyframe), "cold" (this viewer started it) or "dedicated" (a private stream, for a
// player that can't play the shared one's format).
// startedHere says the caller already started the stream (prestartLive) for this viewer.
func (h *hub) joinLive(ctx context.Context, s *system, native, quality, codecs string, startedHere bool) (*liveProducer, *liveViewer, liveJoin, string, error) {
	o := liveOpen{
		key: liveKey(s, native, quality), brand: s.cfg.Kind, codecs: codecs,
		resolve: func(ctx context.Context) (backend.LiveSource, error) { return s.b.Live(ctx, native, quality) },
		onErr:   func(err error) { h.noteErr(s, "live", err) },
	}
	p, created, err := h.live.open(o)
	if err != nil {
		return nil, nil, liveJoin{}, "", err
	}
	start := "cold"
	v, j, err := p.subscribe(ctx, codecs)
	if errors.Is(err, errIncompatible) {
		o.key, start = "", "dedicated"
		if p, _, err = h.live.open(o); err != nil {
			return nil, nil, liveJoin{}, "", err
		}
		v, j, err = p.subscribe(ctx, codecs)
	}
	if err != nil {
		return nil, nil, liveJoin{}, "", err
	}
	if !created && !startedHere && start != "dedicated" {
		start = "warm"
		if j.gop != nil {
			start = "gop"
		}
	}
	if h.cfg.debug {
		log.Printf("live %s/%s (%s): %s start; upstream connect %s, codecs %s, init %s, keyframe %s",
			s.cfg.ID, native, quality, start, ms(j.times.Connect), ms(j.times.Codecs), ms(j.times.Init), ms(j.times.Keyframe))
	}
	return p, v, j, start, nil
}

func ms(d time.Duration) string {
	if d == 0 {
		return "-"
	}
	return d.Round(time.Millisecond).String()
}
