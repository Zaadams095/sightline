package wgtunnel

import (
	"archive/zip"
	"bytes"
	"crypto/ecdsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSignAndVerify(t *testing.T) {
	priv, err := NewSigningKey()
	if err != nil {
		t.Fatal(err)
	}
	pubPEM, err := SigningPublicKeyPEM(priv)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	manifest := filepath.Join(dir, "manifest.json")
	if err := os.WriteFile(manifest, []byte(`{"files":[]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	sigPath := filepath.Join(dir, "manifest.sig")
	if _, err := SignFile(priv, manifest, sigPath); err != nil {
		t.Fatal(err)
	}
	sig, _ := os.ReadFile(sigPath)
	block, _ := pem.Decode([]byte(pubPEM))
	if block == nil || block.Type != "PUBLIC KEY" {
		t.Fatalf("bad PEM %q", pubPEM)
	}
	pk, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(`{"files":[]}`))
	if !ecdsa.VerifyASN1(pk.(*ecdsa.PublicKey), sum[:], sig) {
		t.Fatal("signature doesn't verify")
	}
	// A changed manifest no longer verifies.
	bad := sha256.Sum256([]byte(`{"files":[1]}`))
	if ecdsa.VerifyASN1(pk.(*ecdsa.PublicKey), bad[:], sig) {
		t.Fatal("tampered manifest verified")
	}
	if _, err := SigningPublicKeyPEM("not a key"); err == nil {
		t.Error("expected error for junk key")
	}
}

func TestSHA256File(t *testing.T) {
	p := filepath.Join(t.TempDir(), "a.bin")
	os.WriteFile(p, []byte("abc"), 0o600)
	got, err := SHA256File(p)
	if err != nil {
		t.Fatal(err)
	}
	want := "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
	if got != want {
		t.Fatalf("got %s", got)
	}
	if _, err := SHA256File(filepath.Join(t.TempDir(), "missing")); err == nil {
		t.Error("expected error for missing file")
	}
}

func TestZipFolder(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "video"), 0o700)
	os.WriteFile(filepath.Join(dir, "summary.pdf"), []byte("%PDF-1.4"), 0o600)
	os.WriteFile(filepath.Join(dir, "video", "front.mp4"), bytes.Repeat([]byte{1, 2, 3}, 1000), 0o600)
	out := filepath.Join(t.TempDir(), "export.zip")
	if err := ZipFolder(dir, out, "Sightline export"); err != nil {
		t.Fatal(err)
	}
	zr, err := zip.OpenReader(out)
	if err != nil {
		t.Fatal(err)
	}
	defer zr.Close()
	names := map[string]int{}
	for _, f := range zr.File {
		if f.Method != zip.Store {
			t.Errorf("%s not stored", f.Name)
		}
		rc, _ := f.Open()
		b, _ := io.ReadAll(rc)
		rc.Close()
		names[f.Name] = len(b)
	}
	if names["Sightline export/summary.pdf"] != 8 || names["Sightline export/video/front.mp4"] != 3000 || len(names) != 2 {
		t.Fatalf("zip contents %v", names)
	}
}

func TestRecordRTSP(t *testing.T) {
	addr := fakeCamera(t, "", "")
	out := filepath.Join(t.TempDir(), "rec.mp4")
	id, err := StartRecording("rtsp://"+addr+"/Streaming/tracks/101?starttime=20261011T010000Z", false, out, 30)
	if err != nil {
		t.Fatal(err)
	}
	// The init segment is written as soon as the tracks are known.
	deadline := time.Now().Add(5 * time.Second)
	for {
		var st recordingStatus
		json.Unmarshal([]byte(RecordingStatus(id)), &st)
		if st.Bytes > 0 || time.Now().After(deadline) {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	StopRecording(id)
	b, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	if len(b) < 8 || !bytes.Equal(b[4:8], []byte("ftyp")) {
		t.Fatalf("expected an MP4, got % x", b[:min(16, len(b))])
	}
	var st recordingStatus
	json.Unmarshal([]byte(RecordingStatus(id)), &st)
	if !st.Done || st.Error != "no such recording" {
		t.Errorf("stopped recording should be forgotten, got %+v", st)
	}
	if _, err := StartRecording("http://nope", false, out, 5); err == nil {
		t.Error("expected error for non-RTSP URL")
	}
}
