package wgtunnel

import (
	"bytes"
	"strings"
	"testing"
)

func TestPlaybackRangeInjected(t *testing.T) {
	in := "OPTIONS rtsp://h/x RTSP/1.0\r\nCSeq: 1\r\n\r\n" +
		"PLAY rtsp://h/Streaming/tracks/101?starttime=20261011T143000Z&endtime=20261011T153000Z RTSP/1.0\r\nCSeq: 5\r\nSession: 9\r\n\r\n" +
		"$\x00\x00\x04abcd"
	var out bytes.Buffer
	if err := copyWithPlaybackRange(&out, strings.NewReader(in)); err != nil {
		t.Fatal(err)
	}
	got := out.String()
	if !strings.Contains(got, "Session: 9\r\nRange: clock=20261011T143000Z-\r\n\r\n") {
		t.Fatalf("Range not injected:\n%q", got)
	}
	if !strings.HasPrefix(got, "OPTIONS rtsp://h/x RTSP/1.0\r\nCSeq: 1\r\n\r\n") || !strings.HasSuffix(got, "$\x00\x00\x04abcd") {
		t.Fatalf("other traffic altered:\n%q", got)
	}
}

func TestPlaybackRangeLeavesLiveAndExistingRangeAlone(t *testing.T) {
	cases := []string{
		"PLAY rtsp://h/Streaming/Channels/101 RTSP/1.0\r\nCSeq: 5\r\n\r\n",
		"PLAY rtsp://h/x?starttime=1 RTSP/1.0\r\nCSeq: 5\r\nRange: npt=0-\r\n\r\n",
	}
	for _, in := range cases {
		var out bytes.Buffer
		if err := copyWithPlaybackRange(&out, strings.NewReader(in)); err != nil {
			t.Fatal(err)
		}
		if out.String() != in {
			t.Errorf("modified:\n%q\n%q", in, out.String())
		}
	}
}
