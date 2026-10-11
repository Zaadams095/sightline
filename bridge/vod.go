package main

import (
	"net/url"
	"path"
	"regexp"
	"strings"
)

// HLS playlist rewriting for recordings. The recorder's playlists reference files relative
// to themselves (Frigate: index-v1.m3u8, init-v1.mp4, seg-1-v1.m4s). Every URI is rewritten
// to a relative URL under the Hub's own route, so each follow-up request is grant-checked:
//
//	/v1/recordings/{cam}/vod.m3u8?start=S&end=E          (master, prefix "vod/S/E/")
//	/v1/recordings/{cam}/vod/S/E/index-v1.m3u8           (media playlist, prefix "")
//	/v1/recordings/{cam}/vod/S/E/seg-1-v1.m4s
//
// Only the file's base name is kept, so a playlist can't point the player anywhere else.

var (
	uriAttr      = regexp.MustCompile(`URI="([^"]*)"`)
	safeFileName = regexp.MustCompile(`^[A-Za-z0-9_.\-]+$`)
)

func rewriteURI(u, prefix, query string) string {
	if i := strings.IndexAny(u, "?#"); i >= 0 {
		u = u[:i]
	}
	name := path.Base(u)
	if !safeFileName.MatchString(name) || name == "." || name == ".." {
		return ""
	}
	return prefix + url.PathEscape(name) + query
}

func rewritePlaylist(body, prefix, query string) string {
	lines := strings.Split(body, "\n")
	out := lines[:0]
	for _, line := range lines {
		t := strings.TrimSpace(line)
		switch {
		case t == "":
			out = append(out, t)
		case strings.HasPrefix(t, "#"):
			out = append(out, uriAttr.ReplaceAllStringFunc(t, func(m string) string {
				return `URI="` + rewriteURI(uriAttr.FindStringSubmatch(m)[1], prefix, query) + `"`
			}))
		default:
			if r := rewriteURI(t, prefix, query); r != "" {
				out = append(out, r)
			}
		}
	}
	return strings.Join(out, "\n")
}
