package wgtunnel

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"sync"
	"sync/atomic"
	"time"
)

// Recording an RTSP stream (live or a recorder's replay) to an MP4 file on the phone. Used by
// "Export for police or insurance" for brands whose recorders only replay video as a stream
// (Hikvision, Dahua…): the replay plays in real time, so a 10-minute window takes 10 minutes.
// The file is fragmented MP4 (the same muxer as live view), which iPhones play and AirDrop.

// maxRecordBytes stops a runaway recording (a replay that never ends) from filling the phone.
const maxRecordBytes = 4 << 30

type recording struct {
	src     *rtspSource
	file    *os.File
	bytes   atomic.Int64
	started time.Time
	stop    chan struct{}
	done    chan struct{}
	once    sync.Once

	mu  sync.Mutex
	err string
}

var (
	recMu      sync.Mutex
	recordings = map[int]*recording{}
	recNextID  = 0
)

// countingFile counts bytes written and refuses more than maxRecordBytes.
type countingFile struct{ r *recording }

func (w countingFile) Write(p []byte) (int, error) {
	if w.r.bytes.Load()+int64(len(p)) > maxRecordBytes {
		return 0, errors.New("the recording got too big")
	}
	n, err := w.r.file.Write(p)
	w.r.bytes.Add(int64(n))
	return n, err
}

func rtspTarget(rawURL string) (target string, tls bool, err error) {
	u, err := url.Parse(rawURL)
	if err != nil || (u.Scheme != "rtsp" && u.Scheme != "rtsps") || u.Host == "" {
		return "", false, fmt.Errorf("invalid RTSP URL")
	}
	tls = u.Scheme == "rtsps"
	if u.Port() != "" {
		return u.Host, tls, nil
	}
	def := "554"
	if tls {
		def = "322"
	}
	return net.JoinHostPort(u.Hostname(), def), tls, nil
}

// StartRecording records an RTSP stream into outPath (MP4) for up to maxSeconds and returns a
// recording id for RecordingStatus / StopRecording. It returns once the camera has answered,
// so a wrong address or password fails right away.
func StartRecording(rawURL string, viaTunnel bool, outPath string, maxSeconds int) (int, error) {
	if maxSeconds <= 0 {
		return 0, errors.New("nothing to record")
	}
	target, tls, err := rtspTarget(rawURL)
	if err != nil {
		return 0, err
	}
	src := &rtspSource{rawURL: rawURL, tls: tls, conns: newConnSet()}
	src.viaTunnel.Store(viaTunnel)
	if src.fwd, err = net.Listen("tcp", "127.0.0.1:0"); err != nil {
		return 0, err
	}
	go src.forward(target)

	cons, prod, err := src.startMSE("")
	if err != nil {
		src.fwd.Close()
		src.conns.closeAll()
		return 0, err
	}
	f, err := os.Create(outPath)
	if err != nil {
		_ = prod.Stop()
		_ = cons.Stop()
		src.fwd.Close()
		src.conns.closeAll()
		return 0, err
	}

	r := &recording{src: src, file: f, started: time.Now(), stop: make(chan struct{}), done: make(chan struct{})}
	recMu.Lock()
	recNextID++
	id := recNextID
	recordings[id] = r
	recMu.Unlock()

	ended := make(chan string, 2)
	go func() {
		if err := prod.Start(); err != nil { // blocks until the stream ends
			ended <- err.Error()
			return
		}
		ended <- ""
	}()
	go func() {
		if _, err := cons.WriteTo(countingFile{r}); err != nil {
			ended <- err.Error()
			return
		}
		ended <- ""
	}()
	go func() {
		timer := time.NewTimer(time.Duration(maxSeconds) * time.Second)
		defer timer.Stop()
		var reason string
		select {
		case <-timer.C:
		case <-r.stop:
		case reason = <-ended:
			// A replay that ends by itself is normal (the recorder reached the end).
			if r.bytes.Load() > 0 {
				reason = ""
			} else if reason == "" {
				reason = "the camera sent no video"
			}
		}
		_ = prod.Stop()
		_ = cons.Stop()
		src.fwd.Close()
		src.conns.closeAll()
		if err := f.Close(); err != nil && reason == "" {
			reason = err.Error()
		}
		r.mu.Lock()
		r.err = reason
		r.mu.Unlock()
		close(r.done)
	}()
	return id, nil
}

type recordingStatus struct {
	Bytes   int64   `json:"bytes"`
	Seconds float64 `json:"seconds"`
	Done    bool    `json:"done"`
	Error   string  `json:"error,omitempty"`
}

// RecordingStatus reports a recording's progress as JSON {bytes, seconds, done, error}.
// Unknown ids report done with an error.
func RecordingStatus(id int) string {
	recMu.Lock()
	r := recordings[id]
	recMu.Unlock()
	st := recordingStatus{Done: true, Error: "no such recording"}
	if r != nil {
		st = recordingStatus{Bytes: r.bytes.Load(), Seconds: time.Since(r.started).Seconds()}
		select {
		case <-r.done:
			st.Done = true
			r.mu.Lock()
			st.Error = r.err
			r.mu.Unlock()
		default:
		}
	}
	b, _ := json.Marshal(st)
	return string(b)
}

// StopRecording ends a recording early (the file so far is kept) and waits for it to close.
// After that the id is forgotten.
func StopRecording(id int) {
	recMu.Lock()
	r := recordings[id]
	delete(recordings, id)
	recMu.Unlock()
	if r == nil {
		return
	}
	r.once.Do(func() { close(r.stop) })
	select {
	case <-r.done:
	case <-time.After(10 * time.Second):
	}
}
