// sightline-hub (formerly sightline-bridge).
//
// The Hub wraps one or more camera systems of any registered brand (brands.go) behind a single brand-neutral API
// (/v1, docs/HUB_API.md) with pairing, shared access (grants), Instant Alerts push, and
// optional remote access through Tailscale Funnel. A plain setup page is served at /.
//
// Instant Alerts: it subscribes to each system's event stream (Frigate: MQTT frigate/reviews),
// applies the notification rules each phone syncs to it, and sends a text-only push through
// the Expo Push Service with a tiny end-to-end encrypted thumbnail.
//
// The original bridge API (/devices, /snapshot, /test with X-Bridge-Secret) still works when
// BRIDGE_SECRET is set, so existing installs keep running unchanged.
package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const version = "0.3.0"

func main() {
	cfg := loadConfig()
	store, err := openStore(cfg.dataDir)
	if err != nil {
		log.Fatalf("store: %v", err)
	}
	pusher := newExpoPusher(cfg.expoAccessToken)
	engine := newEngine(store, pusher)
	engine.secret = cfg.secret

	h, err := newHub(cfg, store, engine, pusher)
	if err != nil {
		log.Fatalf("hub: %v", err)
	}
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	h.start(ctx)

	srv := &http.Server{Addr: cfg.listen, Handler: h.handler(api(cfg, store, engine, h)), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		log.Printf("sightline-hub %s listening on %s (setup page: %s)", version, cfg.listen, h.lanURL(nil))
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(sctx)
	h.shutdown()
}

type config struct {
	mqttURL, mqttUser, mqttPass, topicPrefix string
	secret, listen, dataDir, expoAccessToken string
	frigateURL                               string

	hubName string
	// hubURL overrides the LAN address shown in the pairing QR code.
	hubURL string
	// remote enables the "Enable remote access" (Tailscale Funnel) feature.
	remote     bool
	tsHostname string
	// setupHosts are extra host names allowed to load the setup page (DNS-rebinding guard).
	setupHosts []string
	// setupPassword (optional) protects the setup page with a password on the LAN.
	setupPassword string
}

func env(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}

// haOptions are the Home Assistant add-on options (/data/options.json).
type haOptions struct {
	FrigateURL   string `json:"frigate_url"`
	MQTTURL      string `json:"mqtt_url"`
	MQTTUser     string `json:"mqtt_user"`
	MQTTPassword string `json:"mqtt_password"`
	HubName      string `json:"hub_name"`
	RemoteAccess *bool  `json:"remote_access"`
}

func loadConfig() config {
	c := config{
		mqttURL:         env("MQTT_URL", ""),
		mqttUser:        env("MQTT_USER", ""),
		mqttPass:        env("MQTT_PASSWORD", ""),
		topicPrefix:     env("FRIGATE_TOPIC_PREFIX", "frigate"),
		secret:          env("BRIDGE_SECRET", ""),
		listen:          env("LISTEN", ":8086"),
		dataDir:         env("DATA_DIR", "/data"),
		expoAccessToken: env("EXPO_ACCESS_TOKEN", ""),
		frigateURL:      strings.TrimRight(env("FRIGATE_URL", ""), "/"),
		hubName:         env("HUB_NAME", "Home"),
		hubURL:          strings.TrimRight(env("HUB_URL", ""), "/"),
		remote:          env("REMOTE_ACCESS", "on") != "off",
		tsHostname:      env("TS_HOSTNAME", "sightline-hub"),
		setupPassword:   env("SETUP_PASSWORD", ""),
	}
	for _, h := range strings.Split(env("SETUP_HOSTS", ""), ",") {
		if h = strings.TrimSpace(h); h != "" {
			c.setupHosts = append(c.setupHosts, strings.ToLower(h))
		}
	}
	if c.secret != "" && len(c.secret) < 16 {
		log.Fatal("BRIDGE_SECRET must be at least 16 characters. Copy it from the app's Instant Alerts screen.")
	}

	// Home Assistant add-on: options from the add-on configuration tab.
	if b, err := os.ReadFile(filepath.Join(c.dataDir, "options.json")); err == nil {
		var o haOptions
		if json.Unmarshal(b, &o) == nil {
			pick := func(dst *string, v string) {
				if v = strings.TrimSpace(v); v != "" {
					*dst = v
				}
			}
			pick(&c.frigateURL, strings.TrimRight(o.FrigateURL, "/"))
			pick(&c.mqttURL, o.MQTTURL)
			pick(&c.mqttUser, o.MQTTUser)
			pick(&c.mqttPass, o.MQTTPassword)
			pick(&c.hubName, o.HubName)
			if o.RemoteAccess != nil {
				c.remote = *o.RemoteAccess
			}
		}
	}

	// Original bridge installs only set BRIDGE_SECRET and relied on these defaults.
	if c.frigateURL == "" && c.secret != "" {
		c.frigateURL = "http://frigate:5000"
	}
	if c.frigateURL == "none" || c.frigateURL == "off" {
		c.frigateURL = ""
	}
	if c.frigateURL != "" && c.mqttURL == "" {
		c.mqttURL = supervisorMQTT(&c)
	}
	if c.frigateURL != "" && c.mqttURL == "" {
		c.mqttURL = "tcp://mqtt:1883"
	}
	return c
}

// supervisorMQTT asks the Home Assistant Supervisor for the Mosquitto add-on's details, so the
// add-on works with no MQTT settings at all.
func supervisorMQTT(c *config) string {
	token := os.Getenv("SUPERVISOR_TOKEN")
	if token == "" {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://supervisor/services/mqtt", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		log.Printf("Home Assistant MQTT lookup failed: %v", err)
		return ""
	}
	defer resp.Body.Close()
	var out struct {
		Data struct {
			Host     string `json:"host"`
			Port     int    `json:"port"`
			SSL      bool   `json:"ssl"`
			Username string `json:"username"`
			Password string `json:"password"`
		} `json:"data"`
	}
	if resp.StatusCode != http.StatusOK || json.NewDecoder(resp.Body).Decode(&out) != nil || out.Data.Host == "" {
		return ""
	}
	if c.mqttUser == "" {
		c.mqttUser, c.mqttPass = out.Data.Username, out.Data.Password
	}
	scheme := "tcp"
	if out.Data.SSL {
		scheme = "ssl"
	}
	port := out.Data.Port
	if port == 0 {
		port = 1883
	}
	return scheme + "://" + out.Data.Host + ":" + itoa(port)
}

// api is the original bridge API (X-Bridge-Secret). It stays for existing installs.
func api(cfg config, store *store, engine *engine, h *hub) http.Handler {
	mux := http.NewServeMux()
	secretOK := func(r *http.Request) bool {
		got := r.Header.Get("X-Bridge-Secret")
		return cfg.secret != "" && subtle.ConstantTimeCompare([]byte(got), []byte(cfg.secret)) == 1
	}
	authed := func(h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if !secretOK(r) {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			h(w, r)
		}
	}

	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "devices": store.count()})
	})

	// PUT /devices/{token-hash}: register or update a device and its rules.
	mux.HandleFunc("PUT /devices/{id}", authed(func(w http.ResponseWriter, r *http.Request) {
		var d device
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&d); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if !strings.HasPrefix(d.PushToken, "ExponentPushToken[") {
			http.Error(w, "invalid push token", http.StatusBadRequest)
			return
		}
		d.ID = r.PathValue("id")
		d.GrantID = "" // legacy pairing: owner-equivalent
		d.UpdatedAt = time.Now().Unix()
		if err := store.put(d); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))

	mux.HandleFunc("DELETE /devices/{id}", authed(func(w http.ResponseWriter, r *http.Request) {
		_ = store.delete(r.PathValue("id"))
		w.WriteHeader(http.StatusNoContent)
	}))

	// GET /snapshot/{camera}: full-size current frame, for the notification extension on LAN.
	// Hub-paired phones authenticate with their per-device thumbnail key (the extension sends
	// it as X-Bridge-Secret), limited to the cameras their grant allows.
	mux.HandleFunc("GET /snapshot/{camera}", func(w http.ResponseWriter, r *http.Request) {
		camera := r.PathValue("camera")
		if !secretOK(r) && (h == nil || !h.deviceKeyAllows(r.Header.Get("X-Bridge-Secret"), camera)) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if engine.snapshot == nil {
			http.Error(w, "snapshots disabled", http.StatusNotFound)
			return
		}
		img, err := engine.snapshot(r.Context(), camera, 720)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "image/jpeg")
		_, _ = w.Write(img)
	})

	// POST /devices/{id}/checkins/{cid}/ok: "Mom's fine" (check-ins.go).
	mux.HandleFunc("POST /devices/{id}/checkins/{cid}/ok", authed(legacyCheckinOK(h)))

	// POST /test/{id}: send a test notification to one device.
	mux.HandleFunc("POST /test/{id}", authed(func(w http.ResponseWriter, r *http.Request) {
		d, ok := store.get(r.PathValue("id"))
		if !ok {
			http.Error(w, "unknown device", http.StatusNotFound)
			return
		}
		if err := sendTestPush(r.Context(), engine.pusher, d); err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	return mux
}

func sendTestPush(ctx context.Context, p pusher, d device) error {
	return p.send(ctx, []pushMessage{{
		To:    d.PushToken,
		Title: "Instant Alerts are working",
		Body:  "You'll get notifications here the moment a camera sees something.",
		Sound: "default",
	}})
}

func itoa(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}
