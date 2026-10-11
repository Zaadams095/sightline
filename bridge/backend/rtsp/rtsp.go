// Package rtsp is the Hub backend for cameras added by their video link (rtsp://…): any camera
// that streams RTSP, whatever its brand. There's no recorder or API behind a link, so it offers
// live video only; everything else is ErrUnsupported and Capabilities says so.
package rtsp

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	gortsp "github.com/AlexxIT/go2rtc/pkg/rtsp"

	"github.com/zachadams/sightline/bridge/backend"
	"github.com/zachadams/sightline/bridge/backend/httpx"
)

const (
	kind  = "rtsp"
	label = "Camera by video link (RTSP)"
	// maxFields is how many link boxes the setup page shows.
	maxFields = 8
	// FieldCameras is an optional multi-line list for config files and the add-on:
	// one camera per line, "Name | rtsp://main | rtsp://sub" (name and sub-stream optional).
	FieldCameras = "cameras"
)

const linkHint = "rtsp://192.168.1.50:554/stream1"

func fieldKey(i int) string { return "camera" + strconv.Itoa(i) }

func init() {
	fields := []backend.Field{
		{Key: fieldKey(1), Label: "Video link", Hint: linkHint,
			Help: "Find it in the camera's manual or app. To name the camera, put the name first, like: Front door | " + linkHint},
		{Key: backend.FieldUsername, Label: "Username", Optional: true,
			Help: "Only if the camera asks for one and it isn't already in the link."},
		{Key: backend.FieldPassword, Label: "Password", Optional: true},
	}
	for i := 2; i <= maxFields; i++ {
		fields = append(fields, backend.Field{
			Key: fieldKey(i), Label: fmt.Sprintf("Camera %d video link", i), Hint: linkHint,
			Optional: true, Section: "More cameras",
		})
	}
	backend.Register(backend.Descriptor{
		Kind:        kind,
		Label:       label,
		Description: "For a camera that isn't listed: add it by its rtsp:// video link. Live view only.",
		Fields:      fields,
		Order:       101,
		New:         func(c backend.Config) (backend.Backend, error) { return New(c) },
		Probe:       Probe,
	})
}

// Stream is one camera's video links.
type Stream struct {
	ID, Name  string
	Main, Sub string // Sub is "" when only one link was given
}

// RTSP is a set of cameras known only by their links.
type RTSP struct {
	cfg     backend.Config
	streams []Stream
}

// New parses the links; it doesn't touch the network.
func New(cfg backend.Config) (*RTSP, error) {
	s, err := ParseStreams(cfg)
	if err != nil {
		return nil, err
	}
	return &RTSP{cfg: cfg, streams: s}, nil
}

// ParseStreams reads the cameras from the setup fields (camera1…camera8) and the optional
// multi-line "cameras" list, putting the username and password into links that have none.
func ParseStreams(cfg backend.Config) ([]Stream, error) {
	type entry struct{ id, label, raw string }
	var entries []entry
	for i := 1; i <= maxFields; i++ {
		if v := strings.TrimSpace(cfg.Get(fieldKey(i))); v != "" {
			lbl := "the video link"
			if i > 1 {
				lbl = fmt.Sprintf("Camera %d's video link", i)
			}
			entries = append(entries, entry{id: fieldKey(i), label: lbl, raw: v})
		}
	}
	for j, line := range strings.Split(strings.ReplaceAll(cfg.Get(FieldCameras), "\r", ""), "\n") {
		if line = strings.TrimSpace(line); line != "" && !strings.HasPrefix(line, "#") {
			entries = append(entries, entry{id: "line" + strconv.Itoa(j+1), label: fmt.Sprintf("line %d of the camera list", j+1), raw: line})
		}
	}
	if len(entries) == 0 {
		return nil, errors.New("type the camera's video link (like " + linkHint + ")")
	}
	out := make([]Stream, 0, len(entries))
	for n, e := range entries {
		s := Stream{ID: e.id}
		var links []string
		for _, part := range strings.Split(e.raw, "|") {
			part = strings.TrimSpace(part)
			switch {
			case part == "":
			case looksLikeLink(part):
				links = append(links, part)
			case s.Name == "":
				s.Name = part
			}
		}
		if len(links) == 0 {
			return nil, fmt.Errorf("%s has no rtsp:// link in it (like %s)", e.label, linkHint)
		}
		var err error
		if s.Main, err = normalizeLink(links[0], cfg.Username, cfg.Password, e.label); err != nil {
			return nil, err
		}
		if len(links) > 1 {
			if s.Sub, err = normalizeLink(links[1], cfg.Username, cfg.Password, e.label); err != nil {
				return nil, err
			}
		}
		if s.Name == "" {
			name := strings.TrimSpace(cfg.Name)
			switch {
			case name != "" && len(entries) == 1:
				s.Name = name
			case name != "":
				s.Name = fmt.Sprintf("%s %d", name, n+1)
			default:
				s.Name = fmt.Sprintf("Camera %d", n+1)
			}
		}
		out = append(out, s)
	}
	return out, nil
}

// looksLikeLink tells a link ("rtsp://…", or "192.168.1.50:554/live" without the scheme) from
// a camera name ("Front door").
func looksLikeLink(s string) bool {
	if strings.Contains(s, "://") {
		return true
	}
	return !strings.ContainsAny(s, " \t") && strings.Contains(s, ".") && strings.ContainsAny(s, "/:")
}

func normalizeLink(raw, user, pass, what string) (string, error) {
	if !strings.Contains(raw, "://") {
		raw = "rtsp://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" {
		return "", fmt.Errorf("%s doesn't look like a video link. It should look like %s", what, linkHint)
	}
	switch strings.ToLower(u.Scheme) {
	case "rtsp", "rtsps":
	case "http", "https":
		return "", fmt.Errorf("%s starts with %s://, which is the camera's web page. The video link starts with rtsp:// (like %s)", what, u.Scheme, linkHint)
	default:
		return "", fmt.Errorf("%s should start with rtsp:// (like %s)", what, linkHint)
	}
	if u.User == nil && user != "" {
		u.User = url.UserPassword(user, pass)
	}
	return u.String(), nil
}

func (r *RTSP) ID() string    { return r.cfg.ID }
func (r *RTSP) Kind() string  { return kind }
func (r *RTSP) Label() string { return label }

// Capabilities: a bare link gives live video, and talking when the camera behind it offers the
// ONVIF backchannel (the Hub asks it before offering Talk).
func (r *RTSP) Capabilities() backend.Capabilities { return backend.Capabilities{Talk: true} }

func (r *RTSP) Talk(_ context.Context, camera string) (backend.TalkTarget, error) {
	s, err := r.stream(camera)
	if err != nil {
		return backend.TalkTarget{}, err
	}
	if !strings.HasPrefix(s.Main, "rtsp://") && !strings.HasPrefix(s.Main, "rtsps://") {
		return backend.TalkTarget{}, backend.ErrUnsupported
	}
	return backend.TalkTarget{Kind: "rtsp", URL: s.Main}, nil
}

func (r *RTSP) Cameras(context.Context) ([]backend.Camera, error) {
	out := make([]backend.Camera, 0, len(r.streams))
	for _, s := range r.streams {
		out = append(out, backend.Camera{ID: s.ID, Name: s.Name, Enabled: true, Aspect: 16.0 / 9})
	}
	return out, nil
}

func (r *RTSP) stream(id string) (Stream, error) {
	for _, s := range r.streams {
		if s.ID == id {
			return s, nil
		}
	}
	return Stream{}, backend.ErrNotFound
}

func (r *RTSP) Live(_ context.Context, camera, quality string) (backend.LiveSource, error) {
	s, err := r.stream(camera)
	if err != nil {
		return backend.LiveSource{}, err
	}
	u := s.Main
	if quality == "sub" && s.Sub != "" {
		u = s.Sub
	}
	return backend.LiveSource{Kind: backend.LiveRTSP, URL: u}, nil
}

// Health lists cameras whose link no longer answers (a plain TCP connection to its port).
func (r *RTSP) Health(ctx context.Context) (backend.Health, error) {
	var h backend.Health
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, s := range r.streams {
		wg.Go(func() {
			if err := dial(ctx, s.Main, 3*time.Second); err != nil {
				mu.Lock()
				h.Offline = append(h.Offline, s.ID)
				mu.Unlock()
			}
		})
	}
	wg.Wait()
	order := map[string]int{}
	for i, s := range r.streams {
		order[s.ID] = i
	}
	sort.Slice(h.Offline, func(i, j int) bool { return order[h.Offline[i]] < order[h.Offline[j]] })
	return h, nil
}

// hostPort is the link's address with RTSP's usual port filled in.
func hostPort(link string) (string, error) {
	u, err := url.Parse(link)
	if err != nil {
		return "", err
	}
	port := u.Port()
	if port == "" {
		port = "554"
		if strings.EqualFold(u.Scheme, "rtsps") {
			port = "322"
		}
	}
	return net.JoinHostPort(u.Hostname(), port), nil
}

func dial(ctx context.Context, link string, timeout time.Duration) error {
	addr, err := hostPort(link)
	if err != nil {
		return err
	}
	d := net.Dialer{Timeout: timeout}
	c, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return err
	}
	return c.Close()
}

// Probe checks every link: the camera answers, takes the login and knows the stream (RTSP
// DESCRIBE, as a player would ask).
func Probe(ctx context.Context, cfg backend.Config) error {
	streams, err := ParseStreams(cfg)
	if err != nil {
		return err
	}
	for _, s := range streams {
		if err := checkStream(ctx, s.Main); err != nil {
			if len(streams) == 1 {
				return err
			}
			return fmt.Errorf("%s: %s", s.Name, httpx.Explain(err).Error())
		}
	}
	return nil
}

// authError is a plain message that still matches httpx.ErrAuth.
type authError struct{ msg string }

func (e *authError) Error() string { return e.msg }
func (e *authError) Unwrap() error { return httpx.ErrAuth }

func checkStream(ctx context.Context, link string) error {
	// A plain connection first, so network problems come back as they are (the Hub explains them).
	if err := dial(ctx, link, 5*time.Second); err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() {
		c := gortsp.NewClient(link)
		if err := c.Dial(); err != nil {
			done <- err
			return
		}
		defer c.Close()
		done <- c.Describe()
	}()
	var err error
	select {
	case <-ctx.Done():
		return ctx.Err()
	case err = <-done:
	}
	if err == nil {
		return nil
	}
	msg := err.Error()
	switch {
	case strings.Contains(msg, "user/pass not provided"):
		return &authError{"the camera wants a username and password. Type them in (or put them in the link, like rtsp://user:password@192.168.1.50/stream1)"}
	case strings.Contains(msg, "wrong user/pass"):
		return &authError{"the camera turned down the username or password"}
	case strings.Contains(msg, "wrong response on"):
		return errors.New("the camera answered, but doesn't know that video link. Check the part after the address (like /stream1) in the camera's manual or app")
	}
	var ne net.Error
	if errors.As(err, &ne) {
		return err
	}
	return fmt.Errorf("something answered at that address, but it didn't act like a camera's video link. Check the port in the link (usually 554)")
}

// ---- not available from a bare link ----

func (r *RTSP) Snapshot(context.Context, string, int) ([]byte, string, error) {
	return nil, "", backend.ErrUnsupported
}

func (r *RTSP) Events(context.Context, backend.EventQuery) ([]backend.Event, error) {
	return nil, backend.ErrUnsupported
}

func (r *RTSP) Event(context.Context, string) (backend.Event, error) {
	return backend.Event{}, backend.ErrUnsupported
}

func (r *RTSP) EventThumbnail(context.Context, string) ([]byte, string, error) {
	return nil, "", backend.ErrUnsupported
}

func (r *RTSP) Segments(context.Context, string, float64, float64) ([]backend.Segment, error) {
	return nil, backend.ErrUnsupported
}

func (r *RTSP) VOD(context.Context, string, int64, int64, string, http.Header) (*http.Response, error) {
	return nil, backend.ErrUnsupported
}

func (r *RTSP) Clip(context.Context, string, int64, int64, http.Header) (*http.Response, error) {
	return nil, backend.ErrUnsupported
}

func (r *RTSP) PTZInfo(context.Context, string) (backend.PTZInfo, error) {
	return backend.PTZInfo{}, backend.ErrUnsupported
}

func (r *RTSP) PTZ(context.Context, string, string) error { return backend.ErrUnsupported }

func (r *RTSP) Watch(context.Context, backend.Sink) error { return backend.ErrUnsupported }
