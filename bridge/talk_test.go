package main

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/zachadams/sightline/bridge/backend"
	"github.com/zachadams/sightline/bridge/backend/talk"
	"github.com/zachadams/sightline/bridge/backend/talk/talktest"
)

// fakeTalker is a system with a speaker and a spotlight/siren on "front" only.
type fakeTalker struct {
	*fakeBackend
	rtspURL string
}

func (f *fakeTalker) Capabilities() backend.Capabilities {
	c := f.fakeBackend.Capabilities()
	c.Talk, c.Deter = true, true
	return c
}

func (f *fakeTalker) Talk(_ context.Context, cam string) (backend.TalkTarget, error) {
	if cam != "front" {
		return backend.TalkTarget{}, backend.ErrUnsupported
	}
	return backend.TalkTarget{Kind: talk.KindRTSP, URL: f.rtspURL}, nil
}

func (f *fakeTalker) DeterInfo(_ context.Context, cam string) (backend.DeterInfo, error) {
	if cam != "front" {
		return backend.DeterInfo{}, nil
	}
	return backend.DeterInfo{Light: true, Siren: true, SirenSec: 10}, nil
}

func (f *fakeTalker) Deter(_ context.Context, cam, action string) error {
	if cam != "front" {
		return backend.ErrUnsupported
	}
	f.record("deter " + cam + " " + action)
	return nil
}

func useTalker(t *testing.T, th *testHub, codec string) *talktest.Camera {
	t.Helper()
	cam, err := talktest.NewCamera(codec)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(cam.Close)
	th.h.systems[0].b = &fakeTalker{fakeBackend: th.primary, rtspURL: cam.URL}
	return cam
}

func TestTalkAndDeterGrants(t *testing.T) {
	th := newTestHub(t)
	useTalker(t, th, "PCMU/8000")
	roles := []string{roleOwner, roleFull, roleHousehold, roleTemporary, roleLive}
	type tc struct {
		method, path string
		body         any
		want         map[string]int
	}
	cases := []tc{
		{"GET", "/v1/cameras/front/talk", nil, map[string]int{roleOwner: 200, roleFull: 200, roleHousehold: 200, roleTemporary: 403, roleLive: 403}},
		{"GET", "/v1/cameras/front/deter", nil, map[string]int{roleOwner: 200, roleFull: 200, roleHousehold: 200, roleTemporary: 403, roleLive: 403}},
		{"POST", "/v1/cameras/front/deter", map[string]string{"action": "siren"}, map[string]int{roleOwner: 204, roleFull: 204, roleHousehold: 204, roleTemporary: 403, roleLive: 403}},
		// Household only has "front"; the other system has no speaker or lights at all.
		{"GET", "/v1/cameras/back/talk", nil, map[string]int{roleOwner: 501, roleFull: 501, roleHousehold: 404, roleTemporary: 403, roleLive: 403}},
		{"GET", "/v1/cameras/nvr~garage/talk", nil, map[string]int{roleOwner: 501, roleFull: 501, roleHousehold: 404, roleTemporary: 403, roleLive: 403}},
		{"POST", "/v1/cameras/nvr~garage/deter", map[string]string{"action": "siren"}, map[string]int{roleOwner: 501, roleFull: 501, roleHousehold: 404, roleTemporary: 403, roleLive: 403}},
		{"POST", "/v1/cameras/front/deter", map[string]string{"action": "explode"}, map[string]int{roleOwner: 400, roleFull: 400, roleHousehold: 400, roleTemporary: 403, roleLive: 403}},
	}
	for _, c := range cases {
		for _, role := range roles {
			resp := th.do(t, th.tokens[role], c.method, c.path, c.body)
			resp.Body.Close()
			if want := c.want[role]; resp.StatusCode != want {
				t.Errorf("%-9s %s %s: HTTP %d, want %d", role, c.method, c.path, resp.StatusCode, want)
			}
		}
		if resp := th.do(t, "", c.method, c.path, c.body); resp.StatusCode != 401 {
			t.Errorf("no token %s %s: HTTP %d", c.method, c.path, resp.StatusCode)
		}
	}
	if got := strings.Join(th.primary.calls, ","); strings.Count(got, "deter front siren") != 3 {
		t.Errorf("calls = %s", got)
	}

	// /v1/info: only roles that may talk see the features.
	for role, want := range map[string]bool{roleOwner: true, roleHousehold: true, roleLive: false, roleTemporary: false} {
		var info struct {
			Capabilities capabilities `json:"capabilities"`
		}
		th.call(t, th.tokens[role], "GET", "/v1/info", nil, 200, &info)
		if info.Capabilities.Talk != want || info.Capabilities.Deter != want {
			t.Errorf("%s caps = %+v", role, info.Capabilities)
		}
	}
}

func TestTalkProbeAndSession(t *testing.T) {
	th := newTestHub(t)
	cam := useTalker(t, th, "PCMA/8000")

	var avail struct {
		Available bool   `json:"available"`
		Codec     string `json:"codec"`
	}
	th.call(t, th.tokens[roleHousehold], "GET", "/v1/cameras/front/talk", nil, 200, &avail)
	if !avail.Available || avail.Codec != "PCMA/8000" {
		t.Fatalf("probe = %+v", avail)
	}

	wsURL := "ws" + strings.TrimPrefix(th.srv.URL, "http") + "/v1/cameras/front/talk?token=" + th.tokens[roleHousehold]
	c, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	var m wsMessage
	if err := c.ReadJSON(&m); err != nil || m.Type != "talk" || m.Value != "PCMA/8000" {
		t.Fatalf("ready = %+v, %v", m, err)
	}
	deadline := time.After(5 * time.Second)
	for {
		_ = c.WriteMessage(websocket.BinaryMessage, make([]byte, 640))
		select {
		case p := <-cam.Packets:
			if p.PayloadType != 8 || p.Payload[0] != 0xD5 {
				t.Fatalf("packet %+v", p.Header)
			}
			goto guest
		case <-deadline:
			t.Fatal("camera got no audio")
		case <-time.After(20 * time.Millisecond):
		}
	}
guest:
	// A live-only guest is refused before any upgrade.
	_, resp, err := websocket.DefaultDialer.Dial(strings.Replace(wsURL, th.tokens[roleHousehold], th.tokens[roleLive], 1), nil)
	if err == nil || resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Errorf("live guest talk: %v %v", err, resp)
	}
}

func TestTalkWithoutSpeaker(t *testing.T) {
	th := newTestHub(t)
	useTalker(t, th, "")
	var avail struct {
		Available bool `json:"available"`
	}
	th.call(t, th.tokens[roleOwner], "GET", "/v1/cameras/front/talk", nil, 200, &avail)
	if avail.Available {
		t.Error("camera without a backchannel reported as available")
	}
	wsURL := "ws" + strings.TrimPrefix(th.srv.URL, "http") + "/v1/cameras/front/talk?token=" + th.tokens[roleOwner]
	c, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	var m wsMessage
	if err := c.ReadJSON(&m); err != nil || m.Type != "error" || !strings.Contains(m.Value, "speaker") {
		t.Errorf("reply = %+v, %v", m, err)
	}
}
