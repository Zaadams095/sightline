// Package talk sends the phone's voice to a camera's speaker ("two-way audio").
//
// The app captures the microphone and sends 16-bit little-endian mono PCM at 8 kHz (Input*).
// A Session encodes it for the camera (G.711 A-law/µ-law or linear PCM, whatever the camera
// asked for), cuts it into 20 ms RTP packets and hands them to go2rtc's packages, which speak
// the camera's protocol:
//
//   - KindRTSP: the ONVIF Profile T RTSP backchannel (DESCRIBE with
//     "Require: www.onvif.org/ver20/backchannel"). Dahua/Amcrest/Lorex, most ONVIF cameras,
//     Reolink doorbells and go2rtc itself (Frigate's port 8554) accept it.
//   - KindISAPI: Hikvision's ISAPI two-way audio (/ISAPI/System/TwoWayAudio).
//
// This file is shared by the Hub (bridge/backend/talk) and the app's tunnel library
// (tunnel/talk); keep the two copies identical.
package talk

import (
	"errors"
	"fmt"
	"math/rand/v2"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/AlexxIT/go2rtc/pkg/core"
	"github.com/AlexxIT/go2rtc/pkg/isapi"
	"github.com/AlexxIT/go2rtc/pkg/pcm"
	"github.com/AlexxIT/go2rtc/pkg/rtsp"
	"github.com/pion/rtp"
)

const (
	// InputRate is the sample rate of the PCM the app sends (16-bit little-endian, mono).
	InputRate = 8000
	// FrameMs is the audio carried by one RTP packet.
	FrameMs = 20
	// inputFrame is one packet's worth of input, in bytes.
	inputFrame = InputRate * FrameMs / 1000 * 2
)

const (
	KindRTSP  = "rtsp"
	KindISAPI = "isapi"
)

// ErrNoSpeaker means the camera answered but offers no way to send it audio we can encode.
var ErrNoSpeaker = errors.New("this camera doesn't have a speaker the app can use")

// PickCodec returns the camera's backchannel (an audio track the client sends) and the codec to
// encode for, preferring G.711 (what nearly every camera speaker takes). nil when there is none.
func PickCodec(medias []*core.Media) (*core.Media, *core.Codec) {
	rank := map[string]int{core.CodecPCMA: 1, core.CodecPCMU: 2, core.CodecPCM: 3, core.CodecPCML: 4}
	var bestMedia *core.Media
	var best *core.Codec
	for _, m := range medias {
		if m.Kind != core.KindAudio || m.Direction != core.DirectionSendonly {
			continue
		}
		for _, c := range m.Codecs {
			r, ok := rank[c.Name]
			if !ok {
				continue
			}
			if best == nil || r < rank[best.Name] {
				bestMedia, best = m, c
			}
		}
	}
	return bestMedia, best
}

// Encoder turns the app's PCM into RTP packets for one codec. Input of any length is buffered
// until a whole 20 ms frame is available.
type Encoder struct {
	codec     *core.Codec
	transcode func([]byte) []byte
	pending   []byte
	seq       uint16
	ts        uint32
	tsStep    uint32
	ssrc      uint32
}

func NewEncoder(codec *core.Codec) (*Encoder, error) {
	switch codec.Name {
	case core.CodecPCMA, core.CodecPCMU, core.CodecPCM, core.CodecPCML:
	default:
		return nil, fmt.Errorf("talk: unsupported codec %s", codec.Name)
	}
	dst := codec.Clone()
	if dst.ClockRate == 0 {
		dst.ClockRate = 8000
	}
	src := &core.Codec{Name: core.CodecPCML, ClockRate: InputRate, Channels: 1}
	return &Encoder{
		codec:     codec,
		transcode: pcm.Transcode(dst, src),
		tsStep:    dst.ClockRate * FrameMs / 1000,
		seq:       uint16(rand.Uint32()),
		ts:        rand.Uint32(),
		ssrc:      rand.Uint32(),
	}, nil
}

// Packets encodes input and returns the whole frames it completed.
func (e *Encoder) Packets(input []byte) []*rtp.Packet {
	e.pending = append(e.pending, input...)
	var out []*rtp.Packet
	for len(e.pending) >= inputFrame {
		frame := clampFrame(e.pending[:inputFrame])
		out = append(out, &rtp.Packet{
			Header: rtp.Header{
				Version:        2,
				Marker:         true, // every audio packet is a complete frame
				PayloadType:    e.codec.PayloadType,
				SequenceNumber: e.seq,
				Timestamp:      e.ts,
				SSRC:           e.ssrc,
			},
			Payload: e.transcode(frame),
		})
		e.seq++
		e.ts += e.tsStep
		e.pending = e.pending[inputFrame:]
	}
	if len(e.pending) == 0 {
		e.pending = nil // don't keep growing the old backing array
	}
	return out
}

// clampFrame copies a frame with -32768 raised to -32767: go2rtc's G.711 encoders negate the
// sample, which overflows for -32768 and turns a full-scale peak into silence (a click).
func clampFrame(frame []byte) []byte {
	out := make([]byte, len(frame))
	copy(out, frame)
	for i := 0; i+1 < len(out); i += 2 {
		if out[i] == 0x00 && out[i+1] == 0x80 {
			out[i] = 0x01
		}
	}
	return out
}

// Session is an open audio channel to one camera.
type Session struct {
	Codec *core.Codec

	track *core.Receiver
	mu    sync.Mutex
	enc   *Encoder
	stop  func() error
	done  chan struct{}
	once  sync.Once
}

func newSession(codec *core.Codec, track *core.Receiver, stop func() error) (*Session, error) {
	enc, err := NewEncoder(codec)
	if err != nil {
		return nil, err
	}
	return &Session{Codec: codec, track: track, enc: enc, stop: stop, done: make(chan struct{})}, nil
}

// Write sends PCM from the app (16-bit little-endian mono, InputRate).
func (s *Session) Write(input []byte) {
	s.mu.Lock()
	pkts := s.enc.Packets(input)
	s.mu.Unlock()
	for _, p := range pkts {
		s.track.Input(p)
	}
}

// Done is closed when the camera ends the session (or Close was called).
func (s *Session) Done() <-chan struct{} { return s.done }

// Close hangs up. Safe to call more than once.
func (s *Session) Close() {
	s.once.Do(func() {
		_ = s.stop()
		close(s.done)
	})
}

// Open starts talking to a camera. rawURL is the camera's RTSP URL (KindRTSP) or its HTTP
// address with credentials, http://user:pass@host:port (KindISAPI).
func Open(kind, rawURL string) (*Session, error) {
	if err := validate(kind, rawURL); err != nil {
		return nil, err
	}
	if kind == KindISAPI {
		return openISAPI(rawURL)
	}
	return openRTSP(rawURL)
}

// Probe asks the camera, without opening its speaker, which codec it takes. ErrNoSpeaker (or
// a connection error) means talking isn't possible.
func Probe(kind, rawURL string, timeout time.Duration) (*core.Codec, error) {
	if err := validate(kind, rawURL); err != nil {
		return nil, err
	}
	type result struct {
		codec *core.Codec
		err   error
	}
	ch := make(chan result, 1)
	go func() {
		var r result
		if kind == KindISAPI {
			r.codec, r.err = probeISAPI(rawURL)
		} else {
			r.codec, r.err = probeRTSP(rawURL)
		}
		ch <- r
	}()
	select {
	case r := <-ch:
		return r.codec, r.err
	case <-time.After(timeout):
		return nil, errors.New("the camera didn't answer in time")
	}
}

func validate(kind, rawURL string) error {
	u, err := url.Parse(rawURL)
	if err != nil || u.Host == "" {
		return errors.New("talk: invalid camera address")
	}
	switch kind {
	case KindRTSP:
		if u.Scheme != "rtsp" && u.Scheme != "rtsps" {
			return errors.New("talk: expected an rtsp:// address")
		}
	case KindISAPI:
		if u.Scheme != "http" {
			return errors.New("talk: expected an http:// address")
		}
	default:
		return fmt.Errorf("talk: unknown kind %q", kind)
	}
	return nil
}

// ---- RTSP backchannel ----

func describe(rawURL string) (*rtsp.Conn, *core.Media, *core.Codec, error) {
	conn := rtsp.NewClient(rawURL)
	conn.Backchannel = true
	// Timeout stays 0: go2rtc then allows long silences from the camera (we only send).
	if err := conn.Dial(); err != nil {
		return nil, nil, nil, err
	}
	if err := conn.Describe(); err != nil {
		_ = conn.Stop()
		return nil, nil, nil, err
	}
	media, codec := PickCodec(conn.GetMedias())
	if media == nil {
		_ = conn.Stop()
		return nil, nil, nil, ErrNoSpeaker
	}
	return conn, media, codec, nil
}

func probeRTSP(rawURL string) (*core.Codec, error) {
	conn, _, codec, err := describe(rawURL)
	if err != nil {
		return nil, err
	}
	_ = conn.Stop()
	return codec, nil
}

func openRTSP(rawURL string) (*Session, error) {
	conn, media, codec, err := describe(rawURL)
	if err != nil {
		return nil, err
	}
	track := core.NewReceiver(media, codec)
	// Sets up only the backchannel: no video comes back, so this is cheap over a VPN.
	if err := conn.AddTrack(media, codec, track); err != nil {
		_ = conn.Stop()
		return nil, err
	}
	s, err := newSession(codec, track, conn.Stop)
	if err != nil {
		_ = conn.Stop()
		return nil, err
	}
	go func() {
		_ = conn.Start() // PLAY, then runs until the camera or Close ends it
		s.Close()
	}()
	return s, nil
}

// ---- Hikvision ISAPI ----

func probeISAPI(rawURL string) (*core.Codec, error) {
	c, err := isapi.Dial(rawURL)
	if err != nil {
		return nil, err
	}
	_, codec := PickCodec(c.GetMedias())
	if codec == nil {
		return nil, ErrNoSpeaker
	}
	return codec, nil
}

func openISAPI(rawURL string) (*Session, error) {
	c, err := isapi.Dial(rawURL)
	if err != nil {
		return nil, err
	}
	media, codec := PickCodec(c.GetMedias())
	if media == nil {
		return nil, ErrNoSpeaker
	}
	track := core.NewReceiver(media, codec)
	if err := c.AddTrack(media, codec, track); err != nil {
		return nil, err
	}
	s, err := newSession(codec, track, c.Stop)
	if err != nil {
		return nil, err
	}
	go func() {
		_ = c.Start() // opens the channel and blocks while it's open
		s.Close()
	}()
	return s, nil
}

// FriendlyError is an error as something anyone can act on.
func FriendlyError(err error) string {
	msg := err.Error()
	switch {
	case errors.Is(err, ErrNoSpeaker):
		return "This camera doesn't have a speaker Sightline can use."
	case strings.Contains(msg, "401") || strings.Contains(msg, "user/pass"):
		return "The camera didn't accept its password."
	case strings.Contains(msg, "551") || strings.Contains(msg, "Option not supported"):
		return "This camera doesn't have a speaker Sightline can use."
	case strings.Contains(msg, "453") || strings.Contains(msg, "busy"):
		return "Someone else is already talking through this camera."
	default:
		return "Couldn't connect to the camera's speaker."
	}
}
