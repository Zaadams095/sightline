package main

import "strings"

// Activity zones, mirroring app/src/alerts/zones.ts. Keep the two in sync.
//
// A zone is a polygon in normalized picture coordinates (0..1, origin top-left, independent of
// resolution). "include" zones mean "only alert me about things here"; "exclude" zones mean
// "ignore things here" (the older alert masks). Objects narrows a zone to kinds of things
// (person, vehicle, animal, package); empty means anything that moves.
//
// Zones are applied to an object's foot points (bottom-center of its box, every position seen
// while it was tracked). When the system reports no positions for an event, zones never
// suppress it: Sightline only filters what it actually knows.

type zone struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Mode    string   `json:"mode"` // "include" | "exclude"
	Points  []pt     `json:"points"`
	Objects []string `json:"objects"`
}

const (
	zoneInclude = "include"
	zoneExclude = "exclude"
)

// zonesFor is a camera's zones; phones that only sent the older "masks" get them as exclude
// zones for every kind of object.
func (d device) zonesFor(camera string) []zone {
	if d.Zones != nil {
		if z, ok := d.Zones[camera]; ok {
			return z
		}
		// A newer phone that sends zones also sends masks for older Hubs; zones win.
		return nil
	}
	var out []zone
	for _, poly := range d.Masks[camera] {
		out = append(out, zone{Mode: zoneExclude, Points: poly})
	}
	return out
}

// objectCategory maps a system's object label to the zone categories.
func objectCategory(label string) string {
	l := strings.ToLower(label)
	switch l {
	case "person", "people", "face", "human":
		return "person"
	case "car", "truck", "bus", "motorcycle", "bicycle", "vehicle", "boat", "license_plate", "van":
		return "vehicle"
	case "dog", "cat", "bird", "horse", "animal", "deer", "bear", "cow", "sheep", "fox", "raccoon",
		"squirrel", "rabbit", "pet", "dog_cat":
		return "animal"
	case "package":
		return "package"
	}
	return l
}

// zoneApplies says whether a zone is about this event's objects.
func zoneApplies(z zone, objects []string) bool {
	if len(z.Objects) == 0 {
		return true
	}
	for _, o := range objects {
		if contains(z.Objects, objectCategory(o)) {
			return true
		}
	}
	return false
}

// zonesAllow decides whether an event with these objects and foot points may alert.
func zonesAllow(zones []zone, objects []string, points []pt) bool {
	if len(zones) == 0 || len(points) == 0 {
		return true
	}
	var excl, incl, inclApplies []zone
	for _, z := range zones {
		if len(z.Points) < 3 {
			continue
		}
		switch z.Mode {
		case zoneInclude:
			incl = append(incl, z)
			if zoneApplies(z, objects) {
				inclApplies = append(inclApplies, z)
			}
		default:
			if zoneApplies(z, objects) {
				excl = append(excl, z)
			}
		}
	}
	var free []pt
	for _, p := range points {
		if !insideAny(p, excl) {
			free = append(free, p)
		}
	}
	if len(free) == 0 {
		return false // it never left the ignored areas
	}
	if len(incl) == 0 {
		return true
	}
	for _, p := range free {
		if insideAny(p, inclApplies) {
			return true
		}
	}
	return false
}

func insideAny(p pt, zones []zone) bool {
	for _, z := range zones {
		if pointInPolygon(p, z.Points) {
			return true
		}
	}
	return false
}
