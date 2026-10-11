package reolink

import (
	"context"

	"github.com/zachadams/sightline/bridge/backend"
)

// Talk and deterrence.
//
// Talk: Reolink's own two-way audio is only in its private "Baichuan" protocol, not the HTTP
// API. Some models (the doorbells, notably) also offer the ONVIF backchannel on their RTSP
// stream; the Hub asks the camera and offers Talk only when it does.
//
// Deterrence (abilities as reolink_aio reads them): a spotlight when abilityChn[ch].floodLight
// or supportFLswitch is set (SetWhiteLed state 1/0), a siren when alarmAudio or
// supportAudioAlarm is set (AudioAlarmPlay alarm_mode "times", times 1: it sounds once and
// stops by itself).

func (r *Reolink) Talk(ctx context.Context, camera string) (backend.TalkTarget, error) {
	live, err := r.Live(ctx, camera, "main")
	if err != nil {
		return backend.TalkTarget{}, err
	}
	return backend.TalkTarget{Kind: "rtsp", URL: live.URL}, nil
}

// deterSupport reads a channel's spotlight and siren abilities.
func (a *ability) deterSupport(ch int) backend.DeterInfo {
	return backend.DeterInfo{
		Light: a.ver(ch, "floodLight") > 0 || a.ver(ch, "supportFLswitch") > 0,
		Siren: a.ver(ch, "alarmAudio") > 0 || a.ver(ch, "supportAudioAlarm") > 0,
	}
}

func whiteLedCommand(ch int, on bool) command {
	state := 0
	if on {
		state = 1
	}
	return cmd("SetWhiteLed", map[string]any{"WhiteLed": map[string]any{"channel": ch, "state": state}})
}

func sirenCommand(ch int) command {
	return cmd("AudioAlarmPlay", map[string]any{"alarm_mode": "times", "times": 1, "channel": ch})
}

func (r *Reolink) DeterInfo(ctx context.Context, camera string) (backend.DeterInfo, error) {
	st, c, err := r.channelOf(ctx, camera)
	if err != nil {
		return backend.DeterInfo{}, err
	}
	if st.ability == nil {
		return backend.DeterInfo{}, nil
	}
	return st.ability.deterSupport(c.Ch), nil
}

func (r *Reolink) Deter(ctx context.Context, camera, action string) error {
	st, c, err := r.channelOf(ctx, camera)
	if err != nil {
		return err
	}
	var info backend.DeterInfo
	if st.ability != nil {
		info = st.ability.deterSupport(c.Ch)
	}
	var cm command
	switch {
	case action == backend.DeterLightOn && info.Light:
		cm = whiteLedCommand(c.Ch, true)
	case action == backend.DeterLightOff && info.Light:
		cm = whiteLedCommand(c.Ch, false)
	case action == backend.DeterSiren && info.Siren:
		cm = sirenCommand(c.Ch)
	default:
		return backend.ErrUnsupported
	}
	_, err = r.c.one(ctx, cm)
	return err
}
