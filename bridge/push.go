package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

type pushMessage struct {
	To             string            `json:"to"`
	Title          string            `json:"title"`
	Body           string            `json:"body,omitempty"`
	Sound          string            `json:"sound,omitempty"`
	Priority       string            `json:"priority,omitempty"`
	ThreadID       string            `json:"threadId,omitempty"`
	Data           map[string]string `json:"data,omitempty"`
	MutableContent bool              `json:"mutableContent,omitempty"`
	CategoryID     string            `json:"categoryId,omitempty"`
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
