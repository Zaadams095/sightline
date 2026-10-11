package backend

// How to add a brand backend
//
// Every brand is first-class: the app sees the same /v1 API whatever is behind the Hub, and
// setup must work for someone who has never seen a terminal. A brand never edits the Hub
// itself (hub.go, setup.go, api_v1.go): it is one package plus one line in bridge/brands.go.
//
// 1. Package layout: bridge/backend/<brand>/
//      <brand>.go       type + New + init() Register + the Backend methods
//      types.go         the device's wire types (XML/JSON), if any
//      <brand>_test.go  tests against an httptest.Server that answers like the device
//
// 2. Register in init():
//
//      func init() {
//          backend.Register(backend.Descriptor{
//              Kind:  "hikvision",                       // saved in settings; never change it
//              Label: "Hikvision recorder or camera",    // what people recognize
//              Description: "Also LTS, Annke and other Hikvision-made recorders.",
//              Fields: []backend.Field{
//                  {Key: backend.FieldURL, Label: "Recorder address", Hint: "192.168.1.64"},
//                  {Key: backend.FieldUsername, Label: "Username", Default: "admin"},
//                  {Key: backend.FieldPassword, Label: "Password"},
//                  {Key: "rtspPort", Label: "Video port", Type: backend.FieldNumber,
//                      Optional: true, Default: "554", Section: "More settings"},
//              },
//              DefaultPorts: []int{80, 443},             // tried in order when none is typed
//              New:   func(c backend.Config) (backend.Backend, error) { return New(c) },
//              Probe: func(ctx context.Context, c backend.Config) error { … },
//          })
//      }
//
//    Field keys other than the Field* constants land in Config.Extra (read with c.Get(key)).
//    New must not touch the network. Probe must say what's wrong in plain words ("the
//    password is wrong", "this looks like a camera, not a recorder"); network errors are
//    explained by the Hub, so return them as they are (or wrapped with %w).
//
// 3. Talk HTTP with backend/httpx: httpx.New(cfg.URL, cfg.Username, cfg.Password) gives a
//    client that answers Basic or Digest automatically, accepts self-signed HTTPS, times out,
//    and returns *httpx.StatusError (errors.Is 401 → httpx.ErrAuth, 404 → ErrNotFound).
//    Use c.Stream for recordings (no overall timeout, Range passed through).
//
// 4. Implement Backend. Return ErrUnsupported for what the device can't do, and say so
//    in Capabilities() (the app hides those features). Live: LiveRTSP with credentials in
//    the URL (the Hub restreams it). Recordings: implement VOD for HLS, or Player.Playback
//    for RTSP replays (Live) and MP4 files (File, with StartTime/EndTime when known). Events
//    from the device's push stream go to Watch's Sink for Instant Alerts.
//
//    Optional extras: Talker (two-way audio: return where the speaker is, usually the RTSP
//    URL, which the Hub opens with backend/talk's ONVIF backchannel) and Deterrer (spotlight
//    and siren, gated on the device's own capability flags). Set Capabilities.Talk/Deter.
//
// 5. Add one line to bridge/brands.go: uncomment (or add)
//      import _ "github.com/zachadams/sightline/bridge/backend/<brand>"
//
// 6. Test with httptest: a fake device server (Digest auth included when the real one uses
//    it), checking camera listing, snapshots, the RTSP URLs built, event parsing, playback
//    windows and Probe's plain errors. See frigate/frigate_test.go and httpx/httpx_test.go.
//
// Brands planned (docs/PLATFORM.md §4): hikvision (ISAPI, Digest; RTSP replay ?starttime=),
// dahua (CGI, Digest; /cam/playback), reolink (JSON API with token login; MP4 files),
// unifi (Kind "unifi-protect"; UniFi OS login, RTSPS live, MP4 export), onvif (Profile S/T,
// G for recordings where supported; Order 100) and rtsp (plain RTSP cameras; Order 101).
