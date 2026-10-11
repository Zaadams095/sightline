package dahua

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"time"
)

// Time. Dahua devices speak *local device time* everywhere (search conditions, file times,
// RTSP playback start times) with no zone attached. The Hub measures the device's offset from
// real UTC (global.cgi?action=getCurrentTime against its own clock), as the app does:
//   - When that offset, rounded to 15 minutes, equals the offset of the Hub's own time zone
//     right now (TZ; Home Assistant sets it), the device is taken to be in that zone
//     and times convert with its rules, which know historic DST changes (a recording from
//     before a DST change keeps its right hour). The leftover seconds (a device clock a little
//     fast or slow) are applied on top, since recordings are labelled with that same clock.
//   - Otherwise a fixed offset is used both ways. Limitation: recordings made before a DST
//     change are then off by the DST difference.

// clock converts between unix seconds and device wall time.
type clock struct {
	// offset is device wall clock minus real UTC, in seconds (includes drift).
	offset int64
	// loc is the device's time zone when known (nil: fixed offset).
	loc *time.Location
	// drift is the device clock error (seconds fast) on top of loc's offset.
	drift int64
}

var wallRe = regexp.MustCompile(`(\d{4})[-_/](\d{1,2})[-_/](\d{1,2})[ T_]+(\d{1,2})[:_-](\d{1,2})[:_-](\d{1,2})`)

// wallFields reads "2011-7-3 21:02:32" (also 2011-07-03T21:02:32 or underscores).
func wallFields(s string) ([6]int, bool) {
	var f [6]int
	m := wallRe.FindStringSubmatch(s)
	if m == nil {
		return f, false
	}
	for i := range f {
		f[i], _ = strconv.Atoi(m[i+1])
	}
	return f, true
}

func wallIn(f [6]int, loc *time.Location) time.Time {
	return time.Date(f[0], time.Month(f[1]), f[2], f[3], f[4], f[5], 0, loc)
}

// measureClock builds the clock from a getCurrentTime reply (`result=2011-7-3 21:02:32`), the
// Hub's clock at the time of the reply, and candidate zones the device may be in.
func measureClock(body string, now time.Time, zones ...*time.Location) (clock, error) {
	v := parseKV(body)["result"]
	if v == "" {
		v = body
	}
	f, ok := wallFields(v)
	if !ok {
		return clock{}, fmt.Errorf("unreadable device time")
	}
	offset := int64(math.Round(float64(wallIn(f, time.UTC).Unix()) - float64(now.UnixMilli())/1000))
	zoneMin := int64(math.Round(float64(offset)/900)) * 15
	c := clock{offset: offset}
	for _, z := range zones {
		if z == nil {
			continue
		}
		if _, off := now.In(z).Zone(); int64(off) == zoneMin*60 {
			c.loc, c.drift = z, offset-zoneMin*60
			break
		}
	}
	return c, nil
}

// localClock is "the device is in the Hub's zone", used when the device clock can't be read.
func localClock(loc *time.Location) clock {
	_, off := time.Now().In(loc).Zone()
	return clock{offset: int64(off), loc: loc}
}

// fromDevice: device-local time string → unix seconds.
func (c clock) fromDevice(s string) (float64, bool) {
	f, ok := wallFields(s)
	if !ok {
		return 0, false
	}
	if c.loc != nil {
		return float64(wallIn(f, c.loc).Unix() - c.drift), true
	}
	return float64(wallIn(f, time.UTC).Unix() - c.offset), true
}

// wall is the device's wall clock at unix seconds t, as a time whose fields are device local.
func (c clock) wall(t float64) time.Time {
	sec := int64(math.Floor(t))
	if c.loc != nil {
		return time.Unix(sec+c.drift, 0).In(c.loc)
	}
	return time.Unix(sec+c.offset, 0).UTC()
}

// deviceTime: unix seconds → "2026-10-10 21:02:32" (search conditions).
func (c clock) deviceTime(t float64) string { return c.wall(t).Format("2006-01-02 15:04:05") }

// playbackTime: unix seconds → "2026_10_10_21_02_32" (RTSP playback).
func (c clock) playbackTime(t float64) string { return c.wall(t).Format("2006_01_02_15_04_05") }

// dayRanges splits [after, before] into device-local calendar days, newest first. File searches
// page oldest first with a cap, so busy recorders are searched one day at a time from the
// newest; otherwise the most recent recordings are the ones cut off.
func dayRanges(after, before float64, c clock, maxDays int) [][2]float64 {
	var out [][2]float64
	end := before
	for end > after && len(out) < maxDays {
		day := c.deviceTime(end - 1)[:10]
		dayStart, ok := c.fromDevice(day + " 00:00:00")
		if !ok {
			dayStart = end - 86400
		}
		from := math.Max(after, math.Min(dayStart, end-1))
		out = append(out, [2]float64{from, end})
		end = from
	}
	return out
}
