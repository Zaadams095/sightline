package main

import (
	"context"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/zachadams/sightline/bridge/backend"
)

// Doorbell rings for screens that show them as they happen (the Apple TV's tour switches to
// the doorbell). Any grant may ask, live-only ones included, because a ring is "happening
// now" like live video: only rings from the last two minutes are kept, on the caller's
// cameras, with no event history, thumbnails or recordings.
//
// GET /v1/rings?after=<unix seconds>&wait=<seconds, ≤ 25>
// answers at once if there are newer rings, otherwise waits up to `wait` for one (long poll).

const (
	ringKeep    = 2 * time.Minute
	ringMaxWait = 25 * time.Second
)

type ringView struct {
	ID     string `json:"id"`
	Camera string `json:"camera"`
	// At is when the Hub heard about the ring (unix seconds, the Hub's clock): `after` is
	// compared with this, so a recorder that reports a ring a few seconds late isn't missed.
	At float64 `json:"at"`
	// Start is when the ring happened by the recorder's clock (0 when unknown).
	Start float64 `json:"start"`
}

type ringsReply struct {
	Rings []ringView `json:"rings"`
	// Now is the Hub's clock (unix seconds), to pass back as `after` next time.
	Now float64 `json:"now"`
}

// ringBoard keeps recent rings and wakes waiting requests. The zero value is ready to use.
type ringBoard struct {
	mu    sync.Mutex
	rings []ringView
	seen  map[string]bool
	wake  chan struct{}
}

func (b *ringBoard) waitCh() chan struct{} {
	if b.wake == nil {
		b.wake = make(chan struct{})
	}
	return b.wake
}

// add records a ring (an event whose objects include "doorbell"); repeats of the same event
// (updates as it progresses) are ignored.
func (b *ringBoard) add(e backend.Event, now time.Time) {
	if !isDoorbell(e) {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.seen == nil {
		b.seen = map[string]bool{}
	}
	if b.seen[e.ID] {
		return
	}
	b.seen[e.ID] = true
	b.rings = append(b.rings, ringView{ID: e.ID, Camera: e.Camera, At: float64(now.UnixMilli()) / 1000, Start: e.Start})
	b.prune(now)
	close(b.waitCh())
	b.wake = make(chan struct{})
}

func (b *ringBoard) prune(now time.Time) {
	cut := float64(now.Add(-ringKeep).Unix())
	kept := b.rings[:0]
	for _, r := range b.rings {
		if r.At >= cut {
			kept = append(kept, r)
		} else {
			delete(b.seen, r.ID)
		}
	}
	b.rings = kept
}

// since returns rings after `after` on cameras the filter allows, and a channel that closes
// when a new ring arrives.
func (b *ringBoard) since(after float64, allow func(camera string) bool, now time.Time) ([]ringView, <-chan struct{}) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.prune(now)
	out := []ringView{}
	for _, r := range b.rings {
		if r.At > after && allow(r.Camera) {
			out = append(out, r)
		}
	}
	return out, b.waitCh()
}

// wait answers with rings newer than `after`, waiting up to `wait` for one.
func (b *ringBoard) wait(ctx context.Context, after float64, wait time.Duration, allow func(string) bool) []ringView {
	deadline := time.NewTimer(wait)
	defer deadline.Stop()
	for {
		rings, ch := b.since(after, allow, time.Now())
		if len(rings) > 0 || wait <= 0 {
			return rings
		}
		select {
		case <-ch:
		case <-deadline.C:
			rings, _ := b.since(after, allow, time.Now())
			return rings
		case <-ctx.Done():
			return []ringView{}
		}
	}
}

func (h *hub) handleRings(w http.ResponseWriter, r *http.Request) {
	g := grantFrom(r)
	q := r.URL.Query()
	after, _ := strconv.ParseFloat(q.Get("after"), 64)
	waitSec, _ := strconv.Atoi(q.Get("wait"))
	wait := min(time.Duration(max(0, waitSec))*time.Second, ringMaxWait)
	allow := g.Cameras.has
	rings := h.rings.wait(r.Context(), after, wait, allow)
	writeJSON(w, http.StatusOK, ringsReply{Rings: rings, Now: float64(time.Now().UnixMilli()) / 1000})
}
