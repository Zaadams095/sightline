package wgtunnel

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"io"
	"os"
)

// Evidence signing for exports. The app keeps one P-256 key per phone in the iOS Keychain
// (expo-secure-store) and signs each export's manifest.json with it, so anyone can check that
// the files weren't changed after export:
//
//	openssl dgst -sha256 -verify public-key.pem -signature manifest.sig manifest.json

// NewSigningKey returns a new P-256 private key (PKCS#8, base64).
func NewSigningKey() (string, error) {
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return "", err
	}
	der, err := x509.MarshalPKCS8PrivateKey(k)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(der), nil
}

func parseSigningKey(privB64 string) (*ecdsa.PrivateKey, error) {
	der, err := base64.StdEncoding.DecodeString(privB64)
	if err != nil {
		return nil, errors.New("bad signing key")
	}
	k, err := x509.ParsePKCS8PrivateKey(der)
	if err != nil {
		return nil, errors.New("bad signing key")
	}
	ec, ok := k.(*ecdsa.PrivateKey)
	if !ok || ec.Curve != elliptic.P256() {
		return nil, errors.New("signing key isn't P-256")
	}
	return ec, nil
}

// SigningPublicKeyPEM returns the public half of a key from NewSigningKey as a PEM block.
func SigningPublicKeyPEM(privB64 string) (string, error) {
	k, err := parseSigningKey(privB64)
	if err != nil {
		return "", err
	}
	der, err := x509.MarshalPKIXPublicKey(&k.PublicKey)
	if err != nil {
		return "", err
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})), nil
}

// SignFile signs a file's bytes (ECDSA P-256 with SHA-256, ASN.1 DER) and writes the raw
// signature to sigPath. Returns the signature as base64 too.
func SignFile(privB64, path, sigPath string) (string, error) {
	k, err := parseSigningKey(privB64)
	if err != nil {
		return "", err
	}
	sum, err := fileSHA256(path)
	if err != nil {
		return "", err
	}
	sig, err := ecdsa.SignASN1(rand.Reader, k, sum)
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(sigPath, sig, 0o600); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(sig), nil
}

// SHA256File returns a file's SHA-256 as lowercase hex (streams; fine for large videos).
func SHA256File(path string) (string, error) {
	sum, err := fileSHA256(path)
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(sum), nil
}

func fileSHA256(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return nil, err
	}
	return h.Sum(nil), nil
}
