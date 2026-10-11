package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type pushMessage struct {
	To             string            `json:"to"`
	Title          string            `json:"title,omitempty"` // empty only on Android data-only messages
	Body           string            `json:"body,omitempty"`
	Sound          string            `json:"sound,omitempty"`
	Priority       string            `json:"priority,omitempty"`
	ThreadID       string            `json:"threadId,omitempty"`
	Data           map[string]string `json:"data,omitempty"`
	MutableContent bool              `json:"mutableContent,omitempty"`
	CategoryID     string            `json:"categoryId,omitempty"`
	// iOS: "time-sensitive" breaks through Focus (doorbell rings); needs the app's entitlement.
	InterruptionLevel string `json:"interruptionLevel,omitempty"`
	// Android: the notification channel (created by the app, app/src/alerts/channels.ts).
	ChannelID string `json:"channelId,omitempty"`
}

// Android notification channels. Keep in sync with app/src/alerts/channels.ts.
const (
	channelAlerts   = "alerts"
	channelDoorbell = "doorbell"
	channelPackages = "packages"
	channelCheckins = "checkins"
	channelHealth   = "health"
)

// normPlatform: "android", or "ios" (older apps don't say; they're all iPhones).
func normPlatform(p string) string {
	if strings.EqualFold(strings.TrimSpace(p), "android") {
		return "android"
	}
	return "ios"
}

// Data keys of an Android message (read by app/modules/android-notify, SightlinePush.kt).
const (
	androidMarker   = "slPush"
	androidTitle    = "slTitle"
	androidBody     = "slBody"
	androidChannel  = "slChannel"
	androidCategory = "slCategory"
	androidGroup    = "slGroup"
)

// forDevice shapes a message for the phone that gets it.
//
// iPhones get it as built (the notification service extension adds the picture).
//
// Android phones get a data-only message carrying the title, text, channel and actions in
// `data`. A message with a title is shown by Android itself while the app is in the
// background, which drops the action buttons and can't decrypt the picture; a data-only one
// always reaches the app's own push service (app/modules/android-notify), which builds the
// notification with the buttons, the channel and the decrypted snapshot, or plain text if
// anything about the picture fails.
func forDevice(d device, m pushMessage, channel string) pushMessage {
	m.ChannelID = channel
	if normPlatform(d.Platform) != "android" {
		return m
	}
	data := make(map[string]string, len(m.Data)+6)
	for k, v := range m.Data {
		data[k] = v
	}
	data[androidMarker] = "1"
	data[androidTitle] = m.Title
	data[androidBody] = m.Body
	data[androidChannel] = channel
	if m.CategoryID != "" {
		data[androidCategory] = m.CategoryID
	}
	if m.ThreadID != "" {
		data[androidGroup] = m.ThreadID
	}
	return pushMessage{To: m.To, Priority: "high", Data: data, ChannelID: channel}
}

type pusher interface {
	send(ctx context.Context, msgs []pushMessage) error
}

// expoPusher uses the free Expo Push Service, which relays to APNs / FCM.
type expoPusher struct {
	token  string
	client *http.Client
}

func newExpoPusher(accessToken string) *expoPusher {
	return &expoPusher{token: accessToken, client: &http.Client{Timeout: 15 * time.Second}}
}

const expoPushURL = "https://exp.host/--/api/v2/push/send"

func (p *expoPusher) send(ctx context.Context, msgs []pushMessage) error {
	// Expo accepts up to 100 messages per request.
	for i := 0; i < len(msgs); i += 100 {
		end := min(i+100, len(msgs))
		body, _ := json.Marshal(msgs[i:end])
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, expoPushURL, bytes.NewReader(body))
		if err != nil {
			return err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json")
		if p.token != "" {
			req.Header.Set("Authorization", "Bearer "+p.token)
		}
		resp, err := p.client.Do(req)
		if err != nil {
			return err
		}
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return fmt.Errorf("expo push: HTTP %d: %s", resp.StatusCode, b)
		}
	}
	return nil
}
