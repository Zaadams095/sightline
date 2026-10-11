package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"testing"

	"github.com/zachadams/sightline/bridge/backend"
)

// A brand registered only in tests, shaped like an NVR backend.
func init() {
	backend.Register(backend.Descriptor{
		Kind: "testnvr", Label: "Test recorder", Description: "Only in tests.",
		Fields: []backend.Field{
			{Key: backend.FieldURL, Label: "Recorder address", Hint: "192.168.1.64"},
			{Key: backend.FieldUsername, Label: "Username", Default: "admin"},
			{Key: backend.FieldPassword, Label: "Password"},
			{Key: "channels", Label: "Number of cameras", Type: backend.FieldNumber, Optional: true, Section: "More settings"},
		},
		DefaultPorts: []int{80, 443},
		New: func(c backend.Config) (backend.Backend, error) {
			return &fakeBackend{id: c.ID, cams: []string{"ch1"}}, nil
		},
		Probe: func(_ context.Context, c backend.Config) error {
			if c.Password != "right horse" {
				return errors.New("the password is wrong")
			}
			return nil
		},
	})
}

func TestAddressCandidates(t *testing.T) {
	cases := []struct {
		raw, scheme string
		ports       []int
		want        []string
	}{
		{"192.168.1.64", "", []int{80, 443}, []string{"http://192.168.1.64", "https://192.168.1.64"}},
		{"192.168.1.64:8000", "", []int{80, 443}, []string{"http://192.168.1.64:8000"}},
		{"https://nvr.local/", "", []int{80, 443}, []string{"https://nvr.local"}},
		{"frigate", "http", []int{5000}, []string{"http://frigate:5000"}},
		{" 10.0.0.2 ", "tcp", []int{1883}, []string{"tcp://10.0.0.2:1883"}},
		{"unifi.lan", "https", []int{443}, []string{"https://unifi.lan"}},
	}
	for _, c := range cases {
		got, err := addressCandidates(c.raw, c.scheme, c.ports)
		if err != nil || !slices.Equal(got, c.want) {
			t.Errorf("%q: %v %v, want %v", c.raw, got, err, c.want)
		}
	}
	if _, err := addressCandidates("not an address", "", nil); err == nil {
		t.Error("accepted a sentence as an address")
	}
}

func TestSetupAddsAnyRegisteredBrand(t *testing.T) {
	th := newTestHub(t)
	resp, _ := http.Get(th.srv.URL + "/")
	page, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	for _, s := range []string{"Add a camera system", "Test recorder", "Frigate", `name="kind" value="testnvr"`, `name="f-password" type="password"`, `name="f-channels" inputmode="numeric"`, "More settings", `value="admin"`} {
		if !strings.Contains(string(page), s) {
			t.Errorf("setup page missing %q", s)
		}
	}
	if strings.Contains(string(page), "Frigate's port 5000)</label><input name=\"url\"") {
		t.Error("old Frigate-only form still there")
	}

	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	post := func(form url.Values) string {
		t.Helper()
		req, _ := http.NewRequest("POST", th.srv.URL+"/setup/systems/add", strings.NewReader(form.Encode()))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.Header.Set("Origin", th.srv.URL)
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		loc, _ := url.Parse(resp.Header.Get("Location"))
		return loc.Query().Get("msg")
	}
	th.h.ctx = context.Background()

	// Missing required field, bad number, wrong password: all plain sentences, nothing saved.
	if msg := post(url.Values{"kind": {"testnvr"}, "f-url": {"192.168.1.64"}}); msg != `Please fill in "Password".` {
		t.Errorf("missing password: %q", msg)
	}
	if msg := post(url.Values{"kind": {"testnvr"}, "f-url": {"192.168.1.64"}, "f-password": {"x"}, "f-channels": {"eight"}}); msg != "Number of cameras should be a number." {
		t.Errorf("bad number: %q", msg)
	}
	if msg := post(url.Values{"kind": {"testnvr"}, "f-url": {"192.168.1.64"}, "f-password": {"nope"}}); msg != "Couldn't connect to Test recorder at http://192.168.1.64: the password is wrong." {
		t.Errorf("wrong password: %q", msg)
	}
	if msg := post(url.Values{"kind": {"nope"}}); !strings.Contains(msg, "Pick") {
		t.Errorf("unknown kind: %q", msg)
	}
	if n := len(th.h.settings.Systems); n != 0 {
		t.Fatalf("saved %d systems after failures", n)
	}

	// Success: saved with the brand's extras, default username, and a kind-based ID.
	msg := post(url.Values{"kind": {"testnvr"}, "name": {"Garage NVR"}, "f-url": {"192.168.1.64"}, "f-password": {"right horse"}, "f-channels": {"8"}})
	if msg != "Added Garage NVR." {
		t.Fatalf("add: %q", msg)
	}
	got := th.h.settings.Systems
	if len(got) != 1 || got[0].ID != "testnvr" || got[0].URL != "http://192.168.1.64" || got[0].Username != "admin" ||
		got[0].Password != "right horse" || got[0].Extra["channels"] != "8" || got[0].Name != "Garage NVR" {
		t.Fatalf("saved = %+v", got)
	}
	post(url.Values{"kind": {"testnvr"}, "f-url": {"10.0.0.9:8000"}, "f-password": {"right horse"}})
	if got := th.h.settings.Systems; len(got) != 2 || got[1].ID != "testnvr2" || got[1].URL != "http://10.0.0.9:8000" {
		t.Errorf("second = %+v", got)
	}
}
