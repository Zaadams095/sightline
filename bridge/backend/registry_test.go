package backend

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// stub implements Backend by embedding (unused methods panic); only Cameras is real.
type stub struct {
	Backend
	err error
}

func (s stub) Cameras(context.Context) ([]Camera, error) { return nil, s.err }

func withCleanRegistry(t *testing.T) {
	t.Helper()
	regMu.Lock()
	saved := registry
	registry = map[string]Descriptor{}
	regMu.Unlock()
	t.Cleanup(func() {
		regMu.Lock()
		registry = saved
		regMu.Unlock()
	})
}

func TestRegistry(t *testing.T) {
	withCleanRegistry(t)
	probeErr := errors.New("the password is wrong")
	Register(Descriptor{Kind: "zeta", Label: "Zeta NVR", New: func(c Config) (Backend, error) { return stub{err: probeErr}, nil },
		Fields: []Field{{Key: FieldURL, Label: "Address"}, {Key: FieldPassword, Label: "Password"}, {Key: "channels", Label: "Cameras", Type: FieldNumber}}})
	Register(Descriptor{Kind: "alpha", Label: "Alpha recorder", New: func(Config) (Backend, error) { return stub{}, nil },
		Probe: func(context.Context, Config) error { return nil }})
	Register(Descriptor{Kind: "onvif", Label: "Other camera (ONVIF)", Order: 100, New: func(Config) (Backend, error) { return stub{}, nil }})

	var order []string
	for _, d := range Descriptors() {
		order = append(order, d.Kind)
	}
	if want := "alpha zeta onvif"; strings.Join(order, " ") != want {
		t.Errorf("order = %v, want %s", order, want)
	}
	d, ok := Lookup("zeta")
	if !ok || d.Fields[0].Type != FieldAddress || d.Fields[1].Type != FieldSecret || d.Fields[2].Type != FieldNumber {
		t.Errorf("zeta = %+v", d)
	}

	// Probe: the descriptor's own, else New + Cameras.
	if err := Probe(context.Background(), Config{Kind: "alpha"}); err != nil {
		t.Error(err)
	}
	if err := Probe(context.Background(), Config{Kind: "zeta"}); !errors.Is(err, probeErr) {
		t.Errorf("zeta probe = %v", err)
	}
	if _, err := New(Config{Kind: "nope"}); !errors.Is(err, ErrUnknownKind) {
		t.Errorf("unknown kind = %v", err)
	}

	mustPanic := func(name string, d Descriptor) {
		t.Helper()
		defer func() {
			if recover() == nil {
				t.Errorf("%s: no panic", name)
			}
		}()
		Register(d)
	}
	newFn := func(Config) (Backend, error) { return stub{}, nil }
	mustPanic("duplicate", Descriptor{Kind: "alpha", Label: "Again", New: newFn})
	mustPanic("bad kind", Descriptor{Kind: "Bad Kind", Label: "x", New: newFn})
	mustPanic("no New", Descriptor{Kind: "nonew", Label: "x"})
	mustPanic("field without label", Descriptor{Kind: "nolabel", Label: "x", New: newFn, Fields: []Field{{Key: "k"}}})
}

func TestConfigExtraRoundTrip(t *testing.T) {
	var c Config
	c.Set(FieldURL, "http://10.0.0.2")
	c.Set(FieldPassword, "pw")
	c.Set("channels", "8")
	c.Set("rtspPath", "/Streaming/Channels/101")
	c.Set("rtspPath", "") // clearing removes the key
	if c.URL != "http://10.0.0.2" || c.Get(FieldPassword) != "pw" || c.Get("channels") != "8" || len(c.Extra) != 1 {
		t.Fatalf("config = %+v", c)
	}
	b, _ := json.Marshal(c)
	var back Config
	if err := json.Unmarshal(b, &back); err != nil || back.Get("channels") != "8" {
		t.Fatalf("round trip = %s → %+v, %v", b, back, err)
	}
}
