package wgtunnel

import (
	"bufio"
	"io"
	"net/url"
	"regexp"
	"strings"
)

// clockTime is the RTSP "clock" format (e.g. 20261011T143000Z); nothing else may be injected.
var clockTime = regexp.MustCompile(`^\d{8}T\d{6}(\.\d+)?Z$`)

// copyWithPlaybackRange copies client→camera RTSP traffic, adding a `Range: clock=<start>-`
// header to PLAY when the request URL carries `starttime=` and has no Range of its own.
// Recorders such as Hikvision start archive playback from the Range header, and go2rtc's
// RTSP client doesn't send one, so without this playback would begin at the first segment.
//
// Only the text handshake is inspected; once PLAY has passed, the rest is copied raw.
func copyWithPlaybackRange(dst io.Writer, src io.Reader) error {
	r := bufio.NewReader(src)
	for {
		// Interleaved binary frames ('$') can't precede PLAY in practice; if one appears,
		// stop inspecting and copy everything verbatim.
		b, err := r.Peek(1)
		if err != nil {
			return err
		}
		if b[0] == '$' {
			break
		}
		head, err := readRequestHead(r)
		if err != nil {
			return err
		}
		isPlay := strings.HasPrefix(head, "PLAY ")
		if isPlay {
			head = addRangeHeader(head)
		}
		if _, err := io.WriteString(dst, head); err != nil {
			return err
		}
		if isPlay {
			break
		}
	}
	_, err := io.Copy(dst, r)
	return err
}

// readRequestHead reads one RTSP request through its blank line (requests from go2rtc's
// client to the camera carry no body before PLAY).
func readRequestHead(r *bufio.Reader) (string, error) {
	var sb strings.Builder
	for {
		line, err := r.ReadString('\n')
		sb.WriteString(line)
		if err != nil {
			return sb.String(), err
		}
		if line == "\r\n" || line == "\n" {
			return sb.String(), nil
		}
	}
}

func addRangeHeader(head string) string {
	lines := strings.Split(head, "\r\n")
	if len(lines) < 2 {
		return head
	}
	for _, l := range lines[1:] {
		if strings.HasPrefix(strings.ToLower(l), "range:") {
			return head
		}
	}
	fields := strings.Fields(lines[0])
	if len(fields) < 2 {
		return head
	}
	u, err := url.Parse(fields[1])
	if err != nil {
		return head
	}
	start := u.Query().Get("starttime")
	// Only the "clock" format Range understands (e.g. 20261011T143000Z). Other brands put their
	// own formats in starttime (Dahua: 2026_10_11_14_30_00) and seek by URL alone.
	if !clockTime.MatchString(start) {
		return head
	}
	// starttime is already in the device's clock format (e.g. 20261011T143000Z).
	rangeLine := "Range: clock=" + start + "-"
	// Insert before the terminating blank line.
	out := append([]string{}, lines[:len(lines)-2]...)
	out = append(out, rangeLine, "", "")
	return strings.Join(out, "\r\n")
}
