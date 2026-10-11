package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
)

// Push payloads are capped at ~4 KB, so the bridge embeds a tiny, end-to-end encrypted JPEG
// thumbnail. Apple/Expo only ever see ciphertext; the app's notification extension decrypts
// it with a key derived from the pairing secret it already holds.

const (
	thumbMaxBytes = 1600 // raw JPEG budget; base64(nonce+ct+tag) stays under ~2.3 KB
	thumbWidth    = 192
	keyContext    = "sightline-thumb-v1:"
)

func thumbKey(secret string) []byte {
	k := sha256.Sum256([]byte(keyContext + secret))
	return k[:]
}

// sealThumb encrypts with AES-256-GCM and returns base64(nonce || ciphertext || tag).
func sealThumb(secret string, plain []byte) (string, error) { return sealGCM(thumbKey(secret), plain) }

func openThumb(secret, b64 string) ([]byte, error) { return openGCM(thumbKey(secret), b64) }

// sealGCM is AES-256-GCM with a random nonce: base64(nonce || ciphertext || tag), no
// additional data. The layout CryptoKit's AES.GCM.SealedBox(combined:) and expo-crypto's
// AESSealedData.fromCombined read.
func sealGCM(key, plain []byte) (string, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(gcm.Seal(nonce, nonce, plain, nil)), nil
}

func openGCM(key []byte, b64 string) ([]byte, error) {
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(raw) < gcm.NonceSize() {
		return nil, errors.New("short payload")
	}
	return gcm.Open(nil, raw[:gcm.NonceSize()], raw[gcm.NonceSize():], nil)
}

// tinyJPEG downsizes to thumbWidth and lowers quality until it fits the byte budget.
func tinyJPEG(src []byte) ([]byte, error) {
	img, _, err := image.Decode(bytes.NewReader(src))
	if err != nil {
		return nil, err
	}
	b := img.Bounds()
	w := thumbWidth
	h := b.Dy() * w / max(1, b.Dx())
	for _, scale := range []int{1, 2} {
		small := downscale(img, w/scale, h/scale)
		for q := 60; q >= 20; q -= 8 {
			var buf bytes.Buffer
			if err := jpeg.Encode(&buf, small, &jpeg.Options{Quality: q}); err != nil {
				return nil, err
			}
			if buf.Len() <= thumbMaxBytes {
				return buf.Bytes(), nil
			}
		}
	}
	return nil, errors.New("thumbnail too large")
}

// downscale is an area-average resize (good quality for large reductions, no deps).
func downscale(src image.Image, w, h int) *image.RGBA {
	sb := src.Bounds()
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		y0 := sb.Min.Y + y*sb.Dy()/h
		y1 := max(y0+1, sb.Min.Y+(y+1)*sb.Dy()/h)
		for x := 0; x < w; x++ {
			x0 := sb.Min.X + x*sb.Dx()/w
			x1 := max(x0+1, sb.Min.X+(x+1)*sb.Dx()/w)
			var r, g, bl, n uint32
			for sy := y0; sy < y1; sy++ {
				for sx := x0; sx < x1; sx++ {
					cr, cg, cb, _ := src.At(sx, sy).RGBA()
					r, g, bl, n = r+cr, g+cg, bl+cb, n+1
				}
			}
			dst.SetRGBA(x, y, color.RGBA{uint8(r / n >> 8), uint8(g / n >> 8), uint8(bl / n >> 8), 255})
		}
	}
	return dst
}
