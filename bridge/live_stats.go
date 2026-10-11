package main

import (
	"sort"
	"sync"
	"time"
)

// Live startup timing: each live session's milestones, kept in memory for GET /v1/diagnostics
// (newest liveStatsMax) and logged with LOG_LEVEL=debug. No camera IDs or addresses: only the
// brand, the route it came in on and how long each stage took.

const liveStatsMax = 30

// liveUpstreamTimes are a stream's own milestones in ms from when the Hub started it. For a
// "gop" or "warm" start they happened before this viewer arrived.
type liveUpstreamTimes struct {
	ConnectMs  int64 `json:"connectMs,omitempty"`
	CodecsMs   int64 `json:"codecsMs,omitempty"`
	InitMs     int64 `json:"initMs,omitempty"`
	KeyframeMs int64 `json:"keyframeMs,omitempty"`
}

type liveSessionStat struct {
	Time    int64  `json:"time"`
	Brand   string `json:"brand"`
	Via     string `json:"via"`  // "lan" | "remote"
	Kind    string `json:"kind"` // "mse" | "hls"
	Quality string `json:"quality"`
	// Start: "gop" (cached picture sent at once), "warm" (stream already connected, waited for
	// a keyframe), "cold" (this viewer started the stream), "dedicated" (a private stream for a
	// player that can't play the shared one's format).
	Start    string            `json:"start,omitempty"`
	Upstream liveUpstreamTimes `json:"upstream"`
	// From the request arriving: codecs known, stream ready (init segment), first bytes sent
	// (init), first picture sent (a keyframe).
	CodecsMs     int64   `json:"codecsMs,omitempty"`
	ReadyMs      int64   `json:"readyMs,omitempty"`
	FirstByteMs  int64   `json:"firstByteMs,omitempty"`
	FirstFrameMs int64   `json:"firstFrameMs,omitempty"`
	Seconds      float64 `json:"seconds"`
	Kbps         int64   `json:"kbps"`
	Dropped      int     `json:"dropped,omitempty"`
	Error        string  `json:"error,omitempty"`
}

func msOf(d time.Duration) int64 {
	if d <= 0 {
		return 0
	}
	if m := d.Milliseconds(); m > 0 {
		return m
	}
	return 1
}

// sinceMs is the time since t0 for a milestone that has been reached: at least 1 ms (some
// clocks, Windows' among them, tick coarsely enough to report 0).
func sinceMs(t0 time.Time) int64 {
	if m := time.Since(t0).Milliseconds(); m > 0 {
		return m
	}
	return 1
}

func upstreamTimes(t liveTimes) liveUpstreamTimes {
	return liveUpstreamTimes{ConnectMs: msOf(t.Connect), CodecsMs: msOf(t.Codecs), InitMs: msOf(t.Init), KeyframeMs: msOf(t.Keyframe)}
}

type liveStatsLog struct {
	mu   sync.Mutex
	list []liveSessionStat
}

func (l *liveStatsLog) add(s liveSessionStat) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.list = append(l.list, s)
	if len(l.list) > liveStatsMax {
		l.list = append([]liveSessionStat(nil), l.list[len(l.list)-liveStatsMax:]...)
	}
}

type liveStatsGroup struct {
	Count              int   `json:"count"`
	MedianFirstFrameMs int64 `json:"medianFirstFrameMs,omitempty"`
	MedianReadyMs      int64 `json:"medianReadyMs,omitempty"`
}

type liveStatsSummary struct {
	LAN    liveStatsGroup `json:"lan"`
	Remote liveStatsGroup `json:"remote"`
	Starts map[string]int `json:"starts"`
}

func (l *liveStatsLog) snapshot() ([]liveSessionStat, liveStatsSummary) {
	l.mu.Lock()
	list := append([]liveSessionStat{}, l.list...)
	l.mu.Unlock()
	sum := liveStatsSummary{Starts: map[string]int{}}
	var frames, readies [2][]int64
	for _, s := range list {
		i := 0
		if s.Via == "remote" {
			i = 1
		}
		if s.Start != "" {
			sum.Starts[s.Start]++
		}
		if s.FirstFrameMs > 0 {
			frames[i] = append(frames[i], s.FirstFrameMs)
		}
		if s.ReadyMs > 0 {
			readies[i] = append(readies[i], s.ReadyMs)
		}
		if i == 0 {
			sum.LAN.Count++
		} else {
			sum.Remote.Count++
		}
	}
	sum.LAN.MedianFirstFrameMs, sum.Remote.MedianFirstFrameMs = median(frames[0]), median(frames[1])
	sum.LAN.MedianReadyMs, sum.Remote.MedianReadyMs = median(readies[0]), median(readies[1])
	return list, sum
}

func median(v []int64) int64 {
	if len(v) == 0 {
		return 0
	}
	sort.Slice(v, func(i, j int) bool { return v[i] < v[j] })
	return v[len(v)/2]
}
