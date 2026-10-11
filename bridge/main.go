// sightline-bridge: optional "Instant Alerts" companion for Frigate.
//
// It subscribes to Frigate's MQTT `frigate/reviews` topic, applies the notification rules
// that the app syncs to it, and sends a text-only push through the Expo Push Service.
// No images or video leave the network; the app fetches media over its own connection.
//
// The HTTP API (default :8086) is used only by the app and requires BRIDGE_SECRET.
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
	"strings"
	"syscall"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
)

func main() {
	cfg := loadConfig()
	store, err := openStore(cfg.dataDir)
	if err != nil {
		log.Fatalf("store: %v", err)
	}
	pusher := newExpoPusher(cfg.expoAccessToken)
	engine := newEngine(store, pusher)
	engine.snap = newSnapshotter(cfg.frigateURL)
	engine.secret = cfg.secret

	client := connectMQTT(cfg, engine)

	bgCtx, stopBg := context.WithCancel(context.Background())
	defer stopBg()
	if cfg.frigateURL != "" {
		go newHealthMonitor(cfg.frigateURL, store, pusher).run(bgCtx, time.Minute)
	}
	defer client.Disconnect(250)

	srv := &http.Server{Addr: cfg.listen, Handler: api(cfg, store, engine), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		log.Printf("sightline-bridge listening on %s", cfg.listen)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
}

type config struct {
	mqttURL, mqttUser, mqttPass, topicPrefix string
	secret, listen, dataDir, expoAccessToken string
	frigateURL                               string
}

func env(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}

func loadConfig() config {
	c := config{
		mqttURL:         env("MQTT_URL", "tcp://mqtt:1883"),
		mqttUser:        env("MQTT_USER", ""),
		mqttPass:        env("MQTT_PASSWORD", ""),
		topicPrefix:     env("FRIGATE_TOPIC_PREFIX", "frigate"),
		secret:          env("BRIDGE_SECRET", ""),
		listen:          env("LISTEN", ":8086"),
		dataDir:         env("DATA_DIR", "/data"),
		expoAccessToken: env("EXPO_ACCESS_TOKEN", ""),
		// Frigate's internal port, reachable on the compose network. Used only for snapshots.
		frigateURL: strings.TrimRight(env("FRIGATE_URL", "http://frigate:5000"), "/"),
	}
	if len(c.secret) < 16 {
		log.Fatal("BRIDGE_SECRET must be set (at least 16 characters). Copy it from the app's Instant Alerts screen.")
	}
	return c
}

func connectMQTT(cfg config, engine *engine) mqtt.Client {
	topic := cfg.topicPrefix + "/reviews"
	opts := mqtt.NewClientOptions().
		AddBroker(cfg.mqttURL).
		SetClientID("sightline-bridge").
		SetUsername(cfg.mqttUser).
		SetPassword(cfg.mqttPass).
		SetAutoReconnect(true).
		SetConnectRetry(true).
		SetConnectRetryInterval(5 * time.Second).
		SetOnConnectHandler(func(c mqtt.Client) {
			log.Printf("connected to MQTT, subscribing to %s", topic)
			c.Subscribe(cfg.topicPrefix+"/events", 0, func(_ mqtt.Client, m mqtt.Message) {
				engine.handleEvent(m.Payload())
			})
			c.Subscribe(topic, 0, func(_ mqtt.Client, m mqtt.Message) {
				engine.handle(m.Payload())
			})
		}).
		SetConnectionLostHandler(func(_ mqtt.Client, err error) {
			log.Printf("MQTT connection lost: %v", err)
		})
	client := mqtt.NewClient(opts)
	client.Connect() // retries in the background
	return client
}

func api(cfg config, store *store, engine *engine) http.Handler {
	mux := http.NewServeMux()
	authed := func(h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			got := r.Header.Get("X-Bridge-Secret")
			if subtle.ConstantTimeCompare([]byte(got), []byte(cfg.secret)) != 1 {
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
	mux.HandleFunc("GET /snapshot/{camera}", authed(func(w http.ResponseWriter, r *http.Request) {
		if engine.snap == nil {
			http.Error(w, "snapshots disabled", http.StatusNotFound)
			return
		}
		img, err := engine.snap.fetch(r.Context(), r.PathValue("camera"), 720)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "image/jpeg")
		_, _ = w.Write(img)
	}))

	// POST /test/{id}: send a test notification to one device.
	mux.HandleFunc("POST /test/{id}", authed(func(w http.ResponseWriter, r *http.Request) {
		d, ok := store.get(r.PathValue("id"))
		if !ok {
			http.Error(w, "unknown device", http.StatusNotFound)
			return
		}
		if err := engine.pusher.send(r.Context(), []pushMessage{{
			To:    d.PushToken,
			Title: "Instant Alerts are working",
			Body:  "You'll get notifications here the moment Frigate sees something.",
			Sound: "default",
		}}); err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	return mux
}
