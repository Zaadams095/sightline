package main

import (
	"fmt"
	"math"
	"os"
	"strings"
	"sync"
	"time"
)

// Time-of-day helpers for smart alerts and check-ins. Mirrors app/src/alerts/clock.ts (same
// wording, same DST handling, same sun calculation): keep the two in sync.

var (
	zonesMu sync.Mutex
	zones   = map[string]*time.Location{}
)

// loadZone returns the IANA zone, or nil when tz is empty or unknown.
func loadZone(tz string) *time.Location {
	if tz == "" {
		return nil
	}
	zonesMu.Lock()
	defer zonesMu.Unlock()
	if loc, ok := zones[tz]; ok {
		return loc
	}
	loc, err := time.LoadLocation(tz)
	if err != nil {
		loc = nil
	}
	zones[tz] = loc
	return loc
}

// zoneFor picks the first known zone of the candidates, else the Hub's own.
func zoneFor(tzs ...string) *time.Location {
	for _, tz := range tzs {
		if loc := loadZone(tz); loc != nil {
			return loc
		}
	}
	return time.Local
}

// hubTimezone is the Hub's IANA zone ("" when it isn't set by name, e.g. no TZ variable).
func hubTimezone() string {
	tz := strings.TrimSpace(os.Getenv("TZ"))
	if tz == "" || loadZone(tz) == nil {
		return ""
	}
	return tz
}

func parseHHMM(s string) (int, int) {
	var h, m int
	s = strings.TrimSpace(s)
	if n, _ := fmt.Sscanf(s, "%d:%d", &h, &m); n != 2 || len(s) < 4 {
		return 0, 0
	}
	return min(max(h, 0), 23), min(max(m, 0), 59)
}

// atTimeOfDay is hh:mm on the calendar day of ts in loc (time.Date's DST rules).
func atTimeOfDay(ts int64, hhmm string, loc *time.Location) int64 {
	t := time.Unix(ts, 0).In(loc)
	h, m := parseHHMM(hhmm)
	return time.Date(t.Year(), t.Month(), t.Day(), h, m, 0, 0, loc).Unix()
}

func dayKey(ts int64, loc *time.Location) string {
	return time.Unix(ts, 0).In(loc).Format("2006-01-02")
}

// clockText is "9:15 PM".
func clockText(h, m int) string {
	h12 := h % 12
	if h12 == 0 {
		h12 = 12
	}
	ampm := "AM"
	if h >= 12 {
		ampm = "PM"
	}
	return fmt.Sprintf("%d:%02d %s", h12, m, ampm)
}

// clockAt is the time of ts in lang: "9:15 PM" (English) or "21:15".
func clockAt(lang string, ts int64, loc *time.Location) string {
	t := time.Unix(ts, 0).In(loc)
	return clockTextIn(lang, t.Hour(), t.Minute())
}

// whenText is "today at 9:15 AM" / "yesterday at 9:15 PM" / "on Monday at …" / "on Oct 3 at …"
// (in lang; i18n.go).
func whenText(lang string, ts, now int64, loc *time.Location) string {
	t := time.Unix(ts, 0).In(loc)
	n := time.Unix(now, 0).In(loc)
	at := clockTextIn(lang, t.Hour(), t.Minute())
	d0 := time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
	d1 := time.Date(n.Year(), n.Month(), n.Day(), 0, 0, 0, 0, time.UTC)
	days := int(math.Round(d1.Sub(d0).Hours() / 24))
	switch {
	case days <= 0:
		return tr(lang, "when.today", at)
	case days == 1:
		return tr(lang, "when.yesterday", at)
	case days < 7:
		return tr(lang, "when.weekday", weekdayText(lang, t.Weekday()), at)
	}
	return tr(lang, "when.date", dateText(lang, t), at)
}

type sunPlace struct {
	Lat float64 `json:"lat"`
	Lon float64 `json:"lon"`
}

func hourBucket(h int) string {
	switch {
	case h < 6:
		return "night"
	case h < 12:
		return "morning"
	case h < 18:
		return "afternoon"
	}
	return "evening"
}

// lightAt is "day" or "night": from the sun when the place is known, else 7 PM–6 AM local.
func lightAt(ts int64, loc *time.Location, sun *sunPlace) string {
	if sun == nil {
		h := time.Unix(ts, 0).In(loc).Hour()
		if h >= 19 || h < 6 {
			return "night"
		}
		return "day"
	}
	rad := math.Pi / 180
	u := time.Unix(ts, 0).UTC()
	start := time.Date(u.Year(), 1, 0, 0, 0, 0, 0, time.UTC)
	n := math.Floor(float64(ts-start.Unix()) / 86400)
	decl := -23.44 * math.Cos(2*math.Pi/365*(n+10))
	lat := math.Max(-89.9, math.Min(89.9, sun.Lat))
	cosH := (math.Sin(-0.833*rad) - math.Sin(lat*rad)*math.Sin(decl*rad)) / (math.Cos(lat*rad) * math.Cos(decl*rad))
	if cosH >= 1 {
		return "night"
	}
	if cosH <= -1 {
		return "day"
	}
	half := math.Acos(cosH) / rad / 15
	noon := 12 - sun.Lon/15
	t := float64(ts%86400) / 3600
	since := math.Mod(math.Mod(t-(noon-half), 24)+24, 24)
	if since < 2*half {
		return "day"
	}
	return "night"
}
