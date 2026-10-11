package main

import (
	"strconv"
	"testing"
	"time"

	"github.com/zachadams/sightline/bridge/backend"
)

func TestRingBoard(t *testing.T) {
	var b ringBoard
	now := time.Unix(10_000, 0)
	b.add(backend.Event{ID: "x", Camera: "front", Start: 9990, Objects: []string{"person"}}, now)
	b.add(backend.Event{ID: "r1", Camera: "front", Start: 9995, Objects: []string{"doorbell"}}, now)
	b.add(backend.Event{ID: "r1", Camera: "front", Start: 9995, Objects: []string{"doorbell", "person"}}, now) // update of the same ring
	// Reported late: it started at 9990 but the Hub heard at 10_005. Callers that last asked
	// at 10_001 must still get it.
	later := now.Add(5 * time.Second)
	b.add(backend.Event{ID: "r2", Camera: "back", Start: 9990, Objects: []string{"doorbell"}}, later)
	all := func(string) bool { return true }
	rings, _ := b.since(0, all, later)
	if len(rings) != 2 || rings[0].ID != "r1" || rings[1].At != 10_005 || rings[1].Start != 9990 {
		t.Fatalf("rings = %+v", rings)
	}
	if got, _ := b.since(10_001, all, later); len(got) != 1 || got[0].ID != "r2" {
		t.Fatalf("after 10001 = %+v", got)
	}
	if got, _ := b.since(0, func(c string) bool { return c == "back" }, now); len(got) != 1 {
		t.Fatalf("camera filter = %+v", got)
	}
	// Old rings are forgotten.
	if got, _ := b.since(0, all, now.Add(5*time.Minute)); len(got) != 0 {
		t.Fatalf("expired rings = %+v", got)
	}
}

func TestRingsLongPoll(t *testing.T) {
	th := newTestHub(t)
	sink := &systemSink{h: th.h, s: th.h.systems[0]}
	start := float64(time.Now().Unix()) - 1

	// The live-only TV grant may ask (rings are "now", like live view) but sees only its cameras.
	var reply ringsReply
	done := make(chan struct{})
	go func() {
		defer close(done)
		th.call(t, th.tokens[roleLive], "GET", "/v1/rings?after=0&wait=10", nil, 200, &reply)
	}()
	time.Sleep(200 * time.Millisecond)
	sink.OnEvent(backend.Event{ID: "ring-back", Camera: "back", Start: start, Objects: []string{"doorbell"}})
	time.Sleep(100 * time.Millisecond)
	sink.OnEvent(backend.Event{ID: "ring-front", Camera: "front", Start: start + 0.5, Objects: []string{"doorbell"}})
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("long poll didn't return when the ring arrived")
	}
	if len(reply.Rings) != 1 || reply.Rings[0].Camera != "front" || reply.Now < start {
		t.Fatalf("live grant rings = %+v", reply)
	}

	// The owner sees both; asking again after `now` with no wait returns nothing new.
	var owner ringsReply
	th.call(t, th.tokens[roleOwner], "GET", "/v1/rings?after=0", nil, 200, &owner)
	if len(owner.Rings) != 2 {
		t.Fatalf("owner rings = %+v", owner)
	}
	var none ringsReply
	th.call(t, th.tokens[roleOwner], "GET", "/v1/rings?after="+strconv.FormatFloat(owner.Now, 'f', -1, 64), nil, 200, &none)
	if len(none.Rings) != 0 || none.Rings == nil {
		t.Fatalf("nothing new should be [] (not null): %+v", none)
	}
	th.call(t, "", "GET", "/v1/rings", nil, 401, nil)
}
