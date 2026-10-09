package parcel

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func gatewayFixture(t *testing.T) *fixture {
	f := testApp(t)
	f.a.C.BaseURL = "https://parcel.example.com"
	f.a.C.AdminAuth = "access"
	f.a.gatewaySecret = []byte(strings.Repeat("s", 32))
	f.h = f.a.Handler()
	return f
}
func signedRequest(f *fixture, method, path, body, subject, email string) *http.Request {
	r := httptest.NewRequest(method, f.a.C.BaseURL+path, strings.NewReader(body))
	r.Header.Set("Origin", f.a.C.BaseURL)
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	r.Header.Set("X-Parcel-Timestamp", strconv.FormatInt(f.a.now().Unix(), 10))
	r.Header.Set("X-Parcel-Nonce", randomToken())
	r.Header.Set("X-Parcel-Subject", subject)
	r.Header.Set("X-Parcel-Email", email)
	r.Header.Set("X-Parcel-Client-IP", "198.51.100.9")
	r.RemoteAddr = "127.0.0.1:1234"
	signRequest(f, r, body)
	return r
}
func signRequest(f *fixture, r *http.Request, body string) {
	digest := sha256.Sum256([]byte(body))
	r.Header.Set("X-Parcel-Body-SHA256", hex.EncodeToString(digest[:]))
	canonical := strings.Join([]string{"parcel-gateway-v1", r.Header.Get("X-Parcel-Timestamp"), r.Header.Get("X-Parcel-Nonce"), r.Method, r.URL.RequestURI(), f.a.C.BaseURL,
		r.Header.Get("X-Parcel-Subject"), r.Header.Get("X-Parcel-Email"), r.Header.Get("X-Parcel-Client-IP"), r.Header.Get("X-Parcel-Body-SHA256"), r.Header.Get("Content-Type"), r.Header.Get("X-CSRF-Token"), r.Header.Get("Idempotency-Key"), r.Header.Get("Cookie")}, "\n")
	mac := hmac.New(sha256.New, f.a.gatewaySecret)
	mac.Write([]byte(canonical))
	r.Header.Set("X-Parcel-Signature", hex.EncodeToString(mac.Sum(nil)))
}
func serveGateway(f *fixture, r *http.Request) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	f.h.ServeHTTP(w, r)
	return w
}
func TestGatewayAccessAndCSRF(t *testing.T) {
	f := gatewayFixture(t)
	r := signedRequest(f, "GET", "/api/v1/auth/session", "", "admin-id", "admin@example.com")
	v := decodeResponse[map[string]any](t, serveGateway(f, r), 200)
	if v["auth_mode"] != "access" || v["email"] != "admin@example.com" || v["csrf"] == "" {
		t.Fatal(v)
	}
	// A Parcel password cookie cannot substitute for Access identity.
	r = signedRequest(f, "GET", "/api/v1/admin/status", "", "", "")
	r.AddCookie(f.cookie)
	decodeResponse[map[string]any](t, serveGateway(f, r), 401)
	for _, identity := range []string{"admin-id", "other-admin"} {
		r = signedRequest(f, "POST", "/api/v1/auth/logout", "", identity, "admin@example.com")
		r.Header.Set("X-CSRF-Token", v["csrf"].(string))
		signRequest(f, r, "")
		want := 403
		if identity == "admin-id" {
			want = 200
		}
		result := decodeResponse[map[string]any](t, serveGateway(f, r), want)
		if want == 200 && result["logout_url"] != "/cdn-cgi/access/logout" {
			t.Fatal(result)
		}
	}
	r = signedRequest(f, "POST", "/api/v1/auth/login", `{"password":"test-password"}`, "admin-id", "admin@example.com")
	decodeResponse[map[string]any](t, serveGateway(f, r), 403)
}
func TestGatewayRejectsTamperingAndReplay(t *testing.T) {
	f := gatewayFixture(t)
	for _, field := range []string{"X-Parcel-Subject", "X-Parcel-Email", "X-Parcel-Client-IP", "X-Parcel-Body-SHA256", "X-Parcel-Nonce", "Content-Type", "X-CSRF-Token", "Idempotency-Key"} {
		t.Run(field, func(t *testing.T) {
			r := signedRequest(f, "GET", "/api/v1/auth/session", "", "admin-id", "admin@example.com")
			r.Header.Set(field, "tampered")
			decodeResponse[map[string]any](t, serveGateway(f, r), 403)
		})
	}
	for _, delta := range []time.Duration{-61 * time.Second, 16 * time.Second} {
		r := signedRequest(f, "GET", "/api/v1/auth/session", "", "admin-id", "admin@example.com")
		r.Header.Set("X-Parcel-Timestamp", strconv.FormatInt(f.a.now().Add(delta).Unix(), 10))
		signRequest(f, r, "")
		decodeResponse[map[string]any](t, serveGateway(f, r), 403)
	}
	for _, change := range []func(*http.Request){
		func(r *http.Request) { r.URL.Path = "/api/v1/admin/status" },
		func(r *http.Request) { r.Method = "POST" },
		func(r *http.Request) { r.Header.Add("X-Parcel-Signature", r.Header.Get("X-Parcel-Signature")) },
	} {
		r := signedRequest(f, "GET", "/api/v1/auth/session", "", "admin-id", "admin@example.com")
		change(r)
		decodeResponse[map[string]any](t, serveGateway(f, r), 403)
	}
	r := signedRequest(f, "POST", "/api/v1/auth/logout", "{}", "admin-id", "admin@example.com")
	r.Body = http.NoBody
	decodeResponse[map[string]any](t, serveGateway(f, r), 403)
	r = signedRequest(f, "GET", "/api/v1/auth/session", "", "admin-id", "admin@example.com")
	decodeResponse[map[string]any](t, serveGateway(f, r), 200)
	decodeResponse[map[string]any](t, serveGateway(f, r), 403)
}
func TestGatewayPublicSharesAndLocalReadiness(t *testing.T) {
	f := gatewayFixture(t)
	r := signedRequest(f, "GET", "/api/v1/shares/"+randomToken(), "", "", "")
	decodeResponse[map[string]any](t, serveGateway(f, r), 404)
	for _, path := range []string{"/", "/api/v1/admin/status", "/api/v1/auth/session"} {
		r = httptest.NewRequest("GET", f.a.C.BaseURL+path, nil)
		r.RemoteAddr = "127.0.0.1:1234"
		decodeResponse[map[string]any](t, serveGateway(f, r), 403)
	}
	for _, peer := range []string{"127.0.0.1:1234", "[::1]:1234", "198.51.100.9:1234"} {
		r = httptest.NewRequest("GET", "http://127.0.0.1:8080/readyz", nil)
		r.RemoteAddr = peer
		r.Header.Set("X-Forwarded-For", "127.0.0.1")
		want := 200
		if peer == "198.51.100.9:1234" {
			want = 403
		}
		decodeResponse[map[string]any](t, serveGateway(f, r), want)
	}
}
func TestGatewayClientIPCannotBeSpoofed(t *testing.T) {
	f := gatewayFixture(t)
	r := signedRequest(f, "GET", "/api/v1/auth/session", "", "admin-id", "admin@example.com")
	r.Header.Set("X-Forwarded-For", "127.0.0.1")
	r.Header.Set("CF-Connecting-IP", "127.0.0.1")
	w := httptest.NewRecorder()
	verified, ok := f.a.gatewayRequest(w, r)
	if !ok || f.a.clientIP(verified) != "198.51.100.9" {
		t.Fatal("signed client IP ignored")
	}
}

func TestGatewayOriginAccessCookieDoesNotChangeSignature(t *testing.T) {
	f := gatewayFixture(t)
	id := randomToken()
	grant := "parcel_grant_" + id + "=signed-grant"
	for _, tc := range []struct {
		name, path, subject, email, signedCookie, transportCookie string
	}{
		{"administrator", "/api/v1/auth/session", "admin-id", "admin@example.com", "", "CF_Authorization=origin-service-jwt"},
		{"public", "/api/v1/shares/" + id, "", "", "", "CF_Authorization=origin-service-jwt"},
		{"grant-first", "/api/v1/shares/" + id, "", "", grant, grant + "; CF_Authorization=origin-service-jwt"},
		{"grant-last", "/api/v1/shares/" + id, "", "", grant, "CF_Authorization=origin-service-jwt; " + grant},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := signedRequest(f, "GET", tc.path, "", tc.subject, tc.email)
			r.Header.Set("Cookie", tc.signedCookie)
			signRequest(f, r, "")
			// Origin Access adds its own authorization cookie after Pages signs.
			r.Header.Set("Cookie", tc.transportCookie)
			w := httptest.NewRecorder()
			verified, ok := f.a.gatewayRequest(w, r)
			if !ok {
				t.Fatalf("Origin Access cookie invalidated signature: %s", w.Body.String())
			}
			if got := verified.Header.Get("Cookie"); got != tc.signedCookie {
				t.Fatalf("internal transport cookie reached handlers: %q", got)
			}
		})
	}
	r := signedRequest(f, "GET", "/api/v1/shares/"+id, "", "", "")
	r.Header.Set("Cookie", grant)
	signRequest(f, r, "")
	r.Header.Set("Cookie", "CF_Authorization=origin-service-jwt; parcel_grant_"+id+"=tampered")
	decodeResponse[map[string]any](t, serveGateway(f, r), 403)
}
func TestGatewaySecretFile(t *testing.T) {
	file := filepath.Join(t.TempDir(), "secret")
	for _, tc := range []struct {
		contents string
		mode     os.FileMode
		valid    bool
	}{
		{strings.Repeat("ab", 32) + "\n", 0600, true},
		{strings.Repeat("ab", 32), 0644, false},
		{"short", 0600, false},
		{strings.Repeat("gg", 32), 0600, false},
		{strings.Repeat("ab", 80), 0600, false},
	} {
		if err := os.WriteFile(file, []byte(tc.contents), tc.mode); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(file, tc.mode); err != nil {
			t.Fatal(err)
		}
		secret, err := loadGatewaySecret(file)
		if (err == nil) != tc.valid || tc.valid && len(secret) != 32 {
			t.Fatalf("valid=%v err=%v", tc.valid, err)
		}
	}
}
