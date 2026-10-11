package frigate

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/zachadams/sightline/bridge/backend"
)

func fakeFrigate(t *testing.T) (*Frigate, *[]string) {
	t.Helper()
	var paths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.RequestURI())
		switch {
		case r.URL.Path == "/api/config":
			io.WriteString(w, `{"cameras":{
				"front_door":{"ui":{"order":2},"detect":{"width":1280,"height":720},"zones":{"porch":{}},"objects":{"track":["person","car"]},
					"live":{"streams":{"Main":"front_main","Sub":"front_sub"}},"onvif":{"host":"10.0.0.5"}},
				"back":{"enabled":false,"friendly_name":"Back Yard","ui":{"order":1}},
				"garage":{"ui":{"order":3}}},
				"go2rtc":{"streams":{"front_main":["rtsp://cam/main"],"front_sub":"rtsp://cam/sub","garage":"rtsp://g/1","garage_sub":"rtsp://g/2"}}}`)
		case r.URL.Path == "/api/review":
			io.WriteString(w, `[{"id":"r1","camera":"back","start_time":100.5,"end_time":null,"severity":"alert","thumb_path":"/media/frigate/clips/review/thumb-back-r1.webp","has_been_reviewed":true,"data":{"objects":["person"],"sub_labels":["","Zach"],"zones":[],"detections":["d1"]}}]`)
		case r.URL.Path == "/api/review/r1":
			io.WriteString(w, `{"id":"r1","camera":"back","start_time":100.5,"severity":"alert","thumb_path":"/media/frigate/clips/review/thumb-back-r1.webp","data":{}}`)
		case r.URL.Path == "/clips/review/thumb-back-r1.webp":
			w.Header().Set("Content-Type", "image/webp")
			io.WriteString(w, "webp")
		case r.URL.Path == "/api/back/recordings":
			io.WriteString(w, `[{"start_time":20,"end_time":30},{"start_time":10,"end_time":20},{"start_time":40,"end_time":50}]`)
		case strings.HasPrefix(r.URL.Path, "/vod/"):
			w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
			io.WriteString(w, "#EXTM3U\n")
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return New(backend.Config{ID: "frigate", URL: srv.URL + "/"}), &paths
}

func TestFrigateBackend(t *testing.T) {
	f, paths := fakeFrigate(t)
	ctx := context.Background()

	cams, err := f.Cameras(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(cams) != 3 || cams[0].ID != "back" || cams[0].Name != "Back Yard" || cams[0].Enabled {
		t.Fatalf("cameras[0] = %+v", cams[0])
	}
	if c := cams[1]; c.Name != "Front Door" || !c.PTZ || c.DetectWidth != 1280 || c.Zones[0] != "porch" || c.Aspect < 1.77 {
		t.Fatalf("cameras[1] = %+v", c)
	}

	live, _ := f.Live(ctx, "front_door", "main")
	sub, _ := f.Live(ctx, "front_door", "sub")
	if live.Kind != backend.LiveMSE || !strings.HasSuffix(live.URL, "/live/mse/api/ws?src=front_main") || !strings.HasSuffix(sub.URL, "src=front_sub") {
		t.Fatalf("live = %+v / %+v", live, sub)
	}
	if !strings.HasPrefix(live.URL, "ws://") {
		t.Errorf("live URL scheme: %s", live.URL)
	}
	// Without live.streams, the sub stream is go2rtc's "<camera>_sub" when it exists.
	if sub, _ := f.Live(ctx, "garage", "sub"); !strings.HasSuffix(sub.URL, "src=garage_sub") {
		t.Errorf("garage sub = %+v", sub)
	}
	if main, _ := f.Live(ctx, "garage", "main"); !strings.HasSuffix(main.URL, "src=garage") {
		t.Errorf("garage main = %+v", main)
	}
	if sub, _ := f.Live(ctx, "back", "sub"); !strings.HasSuffix(sub.URL, "src=back") {
		t.Errorf("back sub (no sub stream) = %+v", sub)
	}
	if _, err := f.Live(ctx, "nope", ""); !errors.Is(err, backend.ErrNotFound) {
		t.Errorf("unknown camera live: %v", err)
	}

	// Talk goes to the camera's go2rtc stream over RTSP; cameras without one can't talk.
	if tt, err := f.Talk(ctx, "front_door"); err != nil || tt.Kind != "rtsp" || !strings.HasPrefix(tt.URL, "rtsp://127.0.0.1:8554/front_main") {
		t.Errorf("talk = %+v, %v", tt, err)
	}
	if _, err := f.Talk(ctx, "back"); !errors.Is(err, backend.ErrUnsupported) {
		t.Errorf("talk without a go2rtc stream: %v", err)
	}

	evs, err := f.Events(ctx, backend.EventQuery{Cameras: []string{"back"}, After: 50, Before: 200})
	if err != nil || len(evs) != 1 {
		t.Fatalf("events = %+v, %v", evs, err)
	}
	if e := evs[0]; e.Start != 100.5 || e.End != nil || !e.Reviewed || len(e.SubLabels) != 1 || e.Detections[0] != "d1" {
		t.Errorf("event = %+v", e)
	}
	img, ct, err := f.EventThumbnail(ctx, "r1")
	if err != nil || string(img) != "webp" || ct != "image/webp" {
		t.Errorf("thumbnail = %q %q %v", img, ct, err)
	}

	segs, _ := f.Segments(ctx, "back", 0, 100)
	if len(segs) != 2 || segs[0] != (backend.Segment{Start: 10, End: 30}) {
		t.Errorf("segments = %+v", segs)
	}

	resp, err := f.VOD(ctx, "back", 10, 50, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if _, err := f.VOD(ctx, "back", 10, 50, "../api/config", nil); !errors.Is(err, backend.ErrNotFound) {
		t.Errorf("traversal: %v", err)
	}
	joined := strings.Join(*paths, "\n")
	for _, want := range []string{"/api/review?after=50.000&before=200.000&cameras=back&limit=100", "/api/back/recordings?after=0&before=100", "/vod/back/start/10/end/50/master.m3u8"} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing request %s in\n%s", want, joined)
		}
	}
}

func TestParseMessages(t *testing.T) {
	m, ok, err := ParseReviewMessage([]byte(`{"type":"end","after":{"id":"x"}}`))
	if err != nil || ok || m.After.ID != "x" {
		t.Errorf("end: %v %v", ok, err)
	}
	if _, _, err := ParseReviewMessage([]byte(`nope`)); err == nil {
		t.Error("bad json accepted")
	}
	id, x, y, ok := ParseObjectMessage([]byte(`{"type":"update","after":{"id":"o1","camera":"c","box":[100,200,300,400]}}`))
	if !ok || id != "o1" || x != 200 || y != 400 {
		t.Errorf("object = %v %v %v %v", id, x, y, ok)
	}
}
