package dahua

import (
	"context"
	"fmt"
	"strings"

	"github.com/zachadams/sightline/bridge/backend"
)

// Two-way audio and active deterrence.
//
// Talk: Dahua's RTSP server offers the ONVIF backchannel only on its ONVIF-flavored stream,
// /cam/realmonitor?…&unicast=true&proto=Onvif (what go2rtc documents for Dahua and Amcrest).
//
// Deterrence: cameras with a white light and/or siren ("active deterrence", e.g. the -PV and
// -AS-PV models) take coaxialControlIO.cgi: Type 1 is the white light, Type 2 the siren; IO 1 is
// on and 2 off. The siren sounds for about ten seconds and stops by itself. getStatus lists
// status.status.WhiteLight / Speaker only on cameras that have them (Home Assistant's
// rroller/dahua integration relies on the same answer).

const (
	coaxLight = 1
	coaxSiren = 2
	// sirenSec is how long one siren lasts on these cameras.
	sirenSec = 10
)

// talkPath is the live path whose RTSP session accepts the ONVIF backchannel (sub stream: no
// video is set up anyway, so this costs nothing).
func talkPath(ch int) string {
	return livePath(ch, "sub") + "&unicast=true&proto=Onvif"
}

func (d *Dahua) Talk(ctx context.Context, camera string) (backend.TalkTarget, error) {
	ch, err := parseChannelID(camera)
	if err != nil {
		return backend.TalkTarget{}, err
	}
	return backend.TalkTarget{Kind: "rtsp", URL: d.rtsp(ctx, talkPath(ch))}, nil
}

// parseCoaxStatus reads coaxialControlIO getStatus: which outputs exist.
func parseCoaxStatus(body string) backend.DeterInfo {
	kv := parseKV(body)
	has := func(name string) bool {
		for k := range kv {
			if strings.EqualFold(k, "status.status."+name) {
				return true
			}
		}
		return false
	}
	info := backend.DeterInfo{Light: has("WhiteLight"), Siren: has("Speaker")}
	if info.Siren {
		info.SirenSec = sirenSec
	}
	return info
}

func coaxControlPath(ch, typ int, on bool) string {
	io := 2
	if on {
		io = 1
	}
	return fmt.Sprintf("coaxialControlIO.cgi?action=control&channel=%d&info[0].Type=%d&info[0].IO=%d", ch, typ, io)
}

func (d *Dahua) DeterInfo(ctx context.Context, camera string) (backend.DeterInfo, error) {
	ch, err := parseChannelID(camera)
	if err != nil {
		return backend.DeterInfo{}, err
	}
	body, err := d.cgi(ctx, fmt.Sprintf("coaxialControlIO.cgi?action=getStatus&channel=%d", ch))
	if err != nil || isErrorBody(body) {
		// Cameras without deterrence answer 400/404 or "Error": nothing to show.
		return backend.DeterInfo{}, nil
	}
	return parseCoaxStatus(body), nil
}

func (d *Dahua) Deter(ctx context.Context, camera, action string) error {
	ch, err := parseChannelID(camera)
	if err != nil {
		return err
	}
	info, err := d.DeterInfo(ctx, camera)
	if err != nil {
		return err
	}
	var path string
	switch {
	case action == backend.DeterLightOn && info.Light:
		path = coaxControlPath(ch, coaxLight, true)
	case action == backend.DeterLightOff && info.Light:
		path = coaxControlPath(ch, coaxLight, false)
	case action == backend.DeterSiren && info.Siren:
		path = coaxControlPath(ch, coaxSiren, true)
	default:
		return backend.ErrUnsupported
	}
	body, err := d.cgi(ctx, path)
	if err != nil {
		return err
	}
	if isErrorBody(body) {
		return fmt.Errorf("the camera refused: %s", strings.TrimSpace(body))
	}
	return nil
}
