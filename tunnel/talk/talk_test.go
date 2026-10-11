package talk

import (
	"bytes"
	"encoding/binary"
	"errors"
	"testing"
	"time"

	"github.com/AlexxIT/go2rtc/pkg/core"

	"github.com/zachadams/sightline/tunnel/talk/talktest"
)

// pcm16 is little-endian 16-bit PCM of the given samples.
func pcm16(samples ...int16) []byte {
	b := make([]byte, 2*len(samples))
	for i, s := range samples {
		binary.LittleEndian.PutUint16(b[2*i:], uint16(s))
	}
	return b
}

func repeat(s int16, n int) []byte {
	samples := make([]int16, n)
	for i := range samples {
		samples[i] = s
	}
	return pcm16(samples...)
}

func TestG711Encoding(t *testing.T) {
	// Reference values from ITU-T G.711: silence and full scale.
	for _, tc := range []struct {
		codec  string
		sample int16
		want   byte
	}{
		{core.CodecPCMU, 0, 0xFF},
		{core.CodecPCMU, 32767, 0x80},
		{core.CodecPCMU, -32768, 0x00},
		{core.CodecPCMA, 0, 0xD5},
		{core.CodecPCMA, 32767, 0xAA},
		{core.CodecPCMA, -32768, 0x2A},
	} {
		e, err := NewEncoder(&core.Codec{Name: tc.codec, ClockRate: 8000})
		if err != nil {
			t.Fatal(err)
		}
		pkts := e.Packets(repeat(tc.sample, 160))
		if len(pkts) != 1 || len(pkts[0].Payload) != 160 {
			t.Fatalf("%s: %d packets", tc.codec, len(pkts))
		}
		if got := pkts[0].Payload[0]; got != tc.want {
			t.Errorf("%s(%d) = %#x, want %#x", tc.codec, tc.sample, got, tc.want)
		}
	}
}

func TestFramingIs20msRTP(t *testing.T) {
	e, _ := NewEncoder(&core.Codec{Name: core.CodecPCMA, ClockRate: 8000, PayloadType: 8})
	// 2.5 frames in odd-sized pieces: two packets now, the rest waits for more input.
	in := repeat(1000, 400)
	var pkts = e.Packets(in[:333])
	pkts = append(pkts, e.Packets(in[333:])...)
	if len(pkts) != 2 {
		t.Fatalf("got %d packets, want 2", len(pkts))
	}
	for i, p := range pkts {
		if len(p.Payload) != 160 || p.PayloadType != 8 || !p.Marker || p.Version != 2 {
			t.Errorf("packet %d: %+v len %d", i, p.Header, len(p.Payload))
		}
	}
	if pkts[1].SequenceNumber != pkts[0].SequenceNumber+1 || pkts[1].Timestamp != pkts[0].Timestamp+160 || pkts[1].SSRC != pkts[0].SSRC {
		t.Errorf("sequence/timestamp: %+v then %+v", pkts[0].Header, pkts[1].Header)
	}
	if more := e.Packets(repeat(1000, 80)); len(more) != 1 || more[0].Timestamp != pkts[1].Timestamp+160 {
		t.Errorf("leftover not carried over: %d packets", len(more))
	}
}

func TestWidebandAndLinearCodecs(t *testing.T) {
	// A 16 kHz camera gets twice the samples per 20 ms; L16 is two bytes per sample, big-endian.
	e, _ := NewEncoder(&core.Codec{Name: core.CodecPCM, ClockRate: 16000})
	pkts := e.Packets(repeat(0x0102, 160))
	if len(pkts) != 1 || len(pkts[0].Payload) != 640 || !bytes.Equal(pkts[0].Payload[:2], []byte{1, 2}) {
		t.Fatalf("L16/16000: %d packets, payload %d % x", len(pkts), len(pkts[0].Payload), pkts[0].Payload[:4])
	}
	if p2 := e.Packets(repeat(0, 160)); p2[0].Timestamp-pkts[0].Timestamp != 320 {
		t.Errorf("timestamp step = %d, want 320", p2[0].Timestamp-pkts[0].Timestamp)
	}
	if _, err := NewEncoder(&core.Codec{Name: core.CodecAAC}); err == nil {
		t.Error("AAC should be refused")
	}
}

func TestPickCodec(t *testing.T) {
	medias := []*core.Media{
		{Kind: core.KindVideo, Direction: core.DirectionRecvonly, Codecs: []*core.Codec{{Name: core.CodecH264}}},
		{Kind: core.KindAudio, Direction: core.DirectionRecvonly, Codecs: []*core.Codec{{Name: core.CodecPCMA}}},
		{Kind: core.KindAudio, Direction: core.DirectionSendonly, Codecs: []*core.Codec{{Name: core.CodecAAC}, {Name: core.CodecPCMU}, {Name: core.CodecPCMA}}},
	}
	m, c := PickCodec(medias)
	if m != medias[2] || c.Name != core.CodecPCMA {
		t.Errorf("picked %v %v", m, c)
	}
	if m, _ := PickCodec(medias[:2]); m != nil {
		t.Error("a camera's own audio track isn't a speaker")
	}
}

func TestBackchannelEndToEnd(t *testing.T) {
	cam, err := talktest.NewCamera("PCMU/8000")
	if err != nil {
		t.Fatal(err)
	}
	defer cam.Close()

	codec, err := Probe(KindRTSP, cam.URL, 5*time.Second)
	if err != nil || codec.Name != core.CodecPCMU {
		t.Fatalf("probe = %v, %v", codec, err)
	}
	if !cam.AskedBackchannel() {
		t.Error("DESCRIBE didn't ask for the ONVIF backchannel")
	}

	s, err := Open(KindRTSP, cam.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	deadline := time.After(5 * time.Second)
	var got int
	for got < 3 {
		s.Write(repeat(0, 160))
		select {
		case p := <-cam.Packets:
			if len(p.Payload) != 160 || p.Payload[0] != 0xFF || p.PayloadType != 0 {
				t.Fatalf("packet %+v payload %d % x", p.Header, len(p.Payload), p.Payload[:4])
			}
			got++
		case <-time.After(50 * time.Millisecond):
		case <-deadline:
			t.Fatalf("camera received %d packets", got)
		}
	}
	s.Close()
	select {
	case <-s.Done():
	case <-time.After(time.Second):
		t.Error("Done not closed")
	}
}

func TestNoBackchannel(t *testing.T) {
	cam, _ := talktest.NewCamera("")
	defer cam.Close()
	if _, err := Probe(KindRTSP, cam.URL, 5*time.Second); !errors.Is(err, ErrNoSpeaker) {
		t.Errorf("probe err = %v", err)
	}
	if _, err := Open(KindRTSP, cam.URL); !errors.Is(err, ErrNoSpeaker) {
		t.Errorf("open err = %v", err)
	}
	if FriendlyError(ErrNoSpeaker) == "" {
		t.Error("no message")
	}
	if _, err := Open(KindRTSP, "http://x/"); err == nil {
		t.Error("wrong scheme accepted")
	}
	if _, err := Open("sip", cam.URL); err == nil {
		t.Error("unknown kind accepted")
	}
}
