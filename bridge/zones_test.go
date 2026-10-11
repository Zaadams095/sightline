package main

import (
	"encoding/json"
	"testing"
)

var (
	leftHalf  = []pt{{0, 0}, {0.5, 0}, {0.5, 1}, {0, 1}}
	rightHalf = []pt{{0.5, 0}, {1, 0}, {1, 1}, {0.5, 1}}
	// A concave "L": the bottom strip plus the left column.
	ell = []pt{{0, 0}, {0.3, 0}, {0.3, 0.7}, {1, 0.7}, {1, 1}, {0, 1}}
)

func TestPointInPolygon(t *testing.T) {
	cases := []struct {
		p    pt
		poly []pt
		want bool
	}{
		{pt{0.25, 0.5}, leftHalf, true},
		{pt{0.75, 0.5}, leftHalf, false},
		{pt{0.1, 0.1}, ell, true},                   // left column
		{pt{0.8, 0.9}, ell, true},                   // bottom strip
		{pt{0.8, 0.3}, ell, false},                  // the notch
		{pt{0.5, 0.5}, []pt{{0, 0}, {1, 1}}, false}, // not a polygon
	}
	for i, c := range cases {
		if got := pointInPolygon(c.p, c.poly); got != c.want {
			t.Errorf("case %d: pointInPolygon(%v) = %v, want %v", i, c.p, got, c.want)
		}
	}
}

func TestZonesAllow(t *testing.T) {
	driveway := zone{Name: "Driveway", Mode: zoneInclude, Points: rightHalf, Objects: []string{"vehicle"}}
	porch := zone{Name: "Porch", Mode: zoneInclude, Points: leftHalf, Objects: []string{"person"}}
	street := zone{Name: "Street", Mode: zoneExclude, Points: leftHalf}
	streetCars := zone{Name: "Street", Mode: zoneExclude, Points: leftHalf, Objects: []string{"vehicle"}}
	inLeft := []pt{{0.2, 0.5}, {0.3, 0.6}}
	inRight := []pt{{0.7, 0.5}}
	crossing := []pt{{0.2, 0.5}, {0.8, 0.5}}

	cases := []struct {
		name    string
		zones   []zone
		objects []string
		points  []pt
		want    bool
	}{
		{"no zones", nil, []string{"car"}, inLeft, true},
		{"no positions never suppress", []zone{driveway}, []string{"person"}, nil, true},
		{"exclude: stayed inside", []zone{street}, []string{"car"}, inLeft, false},
		{"exclude: left the area", []zone{street}, []string{"car"}, crossing, true},
		{"exclude for cars ignores only cars", []zone{streetCars}, []string{"person"}, inLeft, true},
		{"exclude for cars drops cars", []zone{streetCars}, []string{"car"}, inLeft, false},
		{"include: car in driveway", []zone{driveway}, []string{"car"}, inRight, true},
		{"include: car outside", []zone{driveway}, []string{"car"}, inLeft, false},
		{"include: person in driveway isn't wanted", []zone{driveway}, []string{"person"}, inRight, false},
		{"include: person on porch", []zone{driveway, porch}, []string{"person"}, inLeft, true},
		{"include: any motion", []zone{{Mode: zoneInclude, Points: rightHalf}}, nil, inRight, true},
		{"include + exclude overlap", []zone{{Mode: zoneInclude, Points: rightHalf}, {Mode: zoneExclude, Points: rightHalf}}, nil, inRight, false},
		{"degenerate zones are ignored", []zone{{Mode: zoneInclude, Points: []pt{{0, 0}, {1, 1}}}}, nil, inLeft, true},
		{"label categories", []zone{{Mode: zoneInclude, Points: rightHalf, Objects: []string{"animal"}}}, []string{"dog"}, inRight, true},
	}
	for _, c := range cases {
		if got := zonesAllow(c.zones, c.objects, c.points); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

func TestZonesForBackwardCompatibleMasks(t *testing.T) {
	// A phone on an older app version sends only masks.
	var old device
	if err := json.Unmarshal([]byte(`{"masks":{"front":[[{"x":0,"y":0},{"x":0.5,"y":0},{"x":0.5,"y":1},{"x":0,"y":1}]]}}`), &old); err != nil {
		t.Fatal(err)
	}
	z := old.zonesFor("front")
	if len(z) != 1 || z[0].Mode != zoneExclude || len(z[0].Points) != 4 || len(z[0].Objects) != 0 {
		t.Fatalf("legacy masks = %+v", z)
	}
	if len(old.zonesFor("back")) != 0 {
		t.Fatal("unexpected zones for a camera without masks")
	}

	// A newer phone sends zones and (for older Hubs) masks; zones win, even when a camera has none.
	var cur device
	if err := json.Unmarshal([]byte(`{
		"zones":{"front":[{"id":"z1","name":"Driveway","mode":"include","points":[{"x":0.5,"y":0},{"x":1,"y":0},{"x":1,"y":1}],"objects":["vehicle"]}]},
		"masks":{"back":[[{"x":0,"y":0},{"x":1,"y":0},{"x":1,"y":1}]]}}`), &cur); err != nil {
		t.Fatal(err)
	}
	if z := cur.zonesFor("front"); len(z) != 1 || z[0].Name != "Driveway" || z[0].Mode != zoneInclude {
		t.Fatalf("zones = %+v", z)
	}
	if z := cur.zonesFor("back"); len(z) != 0 {
		t.Fatalf("masks should be superseded by zones: %+v", z)
	}
}

func TestIncludeZoneFiltersInstantAlerts(t *testing.T) {
	d := device{
		ID: "d", PushToken: "ExponentPushToken[x]", DefaultRule: rule{Enabled: true},
		Zones: map[string][]zone{"front": {
			{ID: "z1", Name: "Driveway", Mode: zoneInclude, Points: rightHalf, Objects: []string{"vehicle"}},
		}},
		DetectSizes: map[string]size{"front": {Width: 1280, Height: 720}},
	}
	e, p := newTestEngine(t, d)
	event := func(id string, x1, x2 float64) []byte {
		b, _ := json.Marshal(map[string]any{"type": "update", "after": map[string]any{"id": id, "camera": "front", "box": []float64{x1, 300, x2, 600}}})
		return b
	}
	rev := func(rid, eid string, objects ...string) []byte {
		r := review{ID: rid, Camera: "front", Severity: "alert", Data: reviewData{Objects: objects, Detections: []string{eid}}}
		b, _ := json.Marshal(reviewMessage{Type: "new", Before: r, After: r})
		return b
	}
	// Car on the street (left): not in the driveway, no alert.
	e.handleEvent(event("e1", 100, 300))
	e.handle(rev("r1", "e1", "car"))
	// Person walking up the driveway: the driveway is only about vehicles.
	e.handleEvent(event("e2", 900, 1100))
	e.handle(rev("r2", "e2", "person"))
	// Car pulling into the driveway: alerts.
	e.handleEvent(event("e3", 100, 300))
	e.handleEvent(event("e3", 900, 1100))
	e.handle(rev("r3", "e3", "car"))
	// Doorbell rings skip zones.
	e.lastCam = map[string]map[string]int64{}
	e.handleEvent(event("e4", 100, 300))
	e.handle(rev("r4", "e4", "doorbell"))

	if len(p.sent) != 2 || p.sent[0].Data["reviewId"] != "r3" || p.sent[1].Data["reviewId"] != "r4" {
		t.Fatalf("sent = %+v", p.sent)
	}
}
