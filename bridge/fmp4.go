package main

import "encoding/binary"

// A small fragmented-MP4 reader for the live GOP cache (live_shared.go): it splits the byte
// stream go2rtc writes (an init segment, then moof+mdat fragments) into init and fragments,
// learns which tracks are video from the init segment, and tells whether a fragment starts
// with a sync sample (a keyframe), from the sample flags in moof/traf (tfhd/trun) or the
// track's trex defaults. ISO/IEC 14496-12 §8.8.

// sampleIsNonSync is sample_is_non_sync_sample in the 32-bit sample flags.
const sampleIsNonSync = 0x00010000

type mp4Box struct {
	typ  string
	data []byte // the box's payload (after the header)
	raw  []byte // the whole box
}

// mp4Boxes splits b into top-level boxes. A truncated or malformed box takes the rest of b.
func mp4Boxes(b []byte) []mp4Box {
	var out []mp4Box
	for len(b) >= 8 {
		size := uint64(binary.BigEndian.Uint32(b))
		typ := string(b[4:8])
		hdr := uint64(8)
		switch size {
		case 0:
			size = uint64(len(b))
		case 1:
			if len(b) < 16 {
				size = uint64(len(b))
				break
			}
			size, hdr = binary.BigEndian.Uint64(b[8:]), 16
		}
		if size < hdr || size > uint64(len(b)) {
			size = uint64(len(b))
			if hdr > size {
				hdr = size
			}
		}
		out = append(out, mp4Box{typ: typ, data: b[hdr:size], raw: b[:size]})
		b = b[size:]
	}
	return out
}

func mp4Child(b []byte, typ string) []byte {
	for _, x := range mp4Boxes(b) {
		if x.typ == typ {
			return x.data
		}
	}
	return nil
}

// splitFMP4 separates init-segment boxes (ftyp, moov) from media fragments. Each fragment is
// a moof with the boxes that follow it up to the next moof. Bytes that aren't ISO boxes at
// all come back as a single fragment, so odd upstreams still pass through.
func splitFMP4(b []byte) (init []byte, frags [][]byte) {
	boxes := mp4Boxes(b)
	if len(boxes) == 0 {
		if len(b) > 0 {
			frags = append(frags, b)
		}
		return nil, frags
	}
	start := -1
	off := 0
	flush := func(end int) {
		if start >= 0 && end > start {
			frags = append(frags, b[start:end])
		}
		start = -1
	}
	for _, x := range boxes {
		n := len(x.raw)
		switch x.typ {
		case "ftyp", "moov":
			flush(off)
			init = append(init, x.raw...)
		case "moof":
			flush(off)
			start = off
		default:
			if start < 0 {
				start = off
			}
		}
		off += n
	}
	flush(off)
	if off < len(b) { // a tail shorter than a box header
		frags = append(frags, b[off:])
	}
	return init, frags
}

// mp4Tracks is what the init segment says about each track.
type mp4Tracks struct {
	video map[uint32]bool
	// defaultFlags are the trex default sample flags by track.
	defaultFlags map[uint32]uint32
}

func parseMP4Init(init []byte) mp4Tracks {
	t := mp4Tracks{video: map[uint32]bool{}, defaultFlags: map[uint32]uint32{}}
	moov := mp4Child(init, "moov")
	for _, x := range mp4Boxes(moov) {
		switch x.typ {
		case "trak":
			id, ok := tkhdTrackID(mp4Child(x.data, "tkhd"))
			if !ok {
				continue
			}
			hdlr := mp4Child(mp4Child(x.data, "mdia"), "hdlr")
			if len(hdlr) >= 12 && string(hdlr[8:12]) == "vide" {
				t.video[id] = true
			}
		case "mvex":
			for _, e := range mp4Boxes(x.data) {
				if e.typ == "trex" && len(e.data) >= 24 {
					t.defaultFlags[binary.BigEndian.Uint32(e.data[4:])] = binary.BigEndian.Uint32(e.data[20:])
				}
			}
		}
	}
	return t
}

func tkhdTrackID(b []byte) (uint32, bool) {
	if len(b) < 4 {
		return 0, false
	}
	off := 12 // version 0: creation, modification (4 each)
	if b[0] == 1 {
		off = 20
	}
	if len(b) < off+4 {
		return 0, false
	}
	return binary.BigEndian.Uint32(b[off:]), true
}

type fragKind int

const (
	// fragOther has no video samples (audio in a stream that has video).
	fragOther fragKind = iota
	// fragDelta starts with a video sample that needs earlier frames.
	fragDelta
	// fragKey starts with a sync sample: a decoder can start here.
	fragKey
)

// classify says whether a fragment can start playback. Streams without any video track
// (audio only) and data the reader can't make sense of count as keys, so they are never held
// back waiting for a keyframe that won't come.
func (t mp4Tracks) classify(frag []byte) fragKind {
	moof := mp4Child(frag, "moof")
	if moof == nil || len(t.video) == 0 {
		return fragKey
	}
	kind := fragOther
	for _, x := range mp4Boxes(moof) {
		if x.typ != "traf" {
			continue
		}
		id, flags, ok := t.firstSampleFlags(x.data)
		if !ok || !t.video[id] {
			continue
		}
		if flags&sampleIsNonSync == 0 {
			return fragKey
		}
		kind = fragDelta
	}
	return kind
}

// firstSampleFlags reads a traf's track ID and the flags of its first sample.
func (t mp4Tracks) firstSampleFlags(traf []byte) (uint32, uint32, bool) {
	tfhd := mp4Child(traf, "tfhd")
	if len(tfhd) < 8 {
		return 0, 0, false
	}
	tf := binary.BigEndian.Uint32(tfhd) & 0xFFFFFF
	id := binary.BigEndian.Uint32(tfhd[4:])
	flags := t.defaultFlags[id]
	off := 8
	for _, f := range []struct {
		bit uint32
		n   int
	}{{0x01, 8}, {0x02, 4}, {0x08, 4}, {0x10, 4}} {
		if tf&f.bit != 0 {
			off += f.n
		}
	}
	if tf&0x20 != 0 && len(tfhd) >= off+4 {
		flags = binary.BigEndian.Uint32(tfhd[off:])
	}
	trun := mp4Child(traf, "trun")
	if len(trun) < 8 {
		return id, flags, true
	}
	rf := binary.BigEndian.Uint32(trun) & 0xFFFFFF
	count := binary.BigEndian.Uint32(trun[4:])
	off = 8
	if rf&0x01 != 0 {
		off += 4
	}
	if rf&0x04 != 0 {
		if len(trun) >= off+4 {
			return id, binary.BigEndian.Uint32(trun[off:]), true
		}
		return id, flags, true
	}
	if rf&0x400 != 0 && count > 0 {
		if rf&0x100 != 0 {
			off += 4
		}
		if rf&0x200 != 0 {
			off += 4
		}
		if len(trun) >= off+4 {
			return id, binary.BigEndian.Uint32(trun[off:]), true
		}
	}
	return id, flags, true
}
