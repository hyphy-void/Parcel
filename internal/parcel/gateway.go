package parcel

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"time"
)

// The edge verifies Access JWTs. The origin accepts identities only in a signed,
// short-lived request, behind an independent Access Service Auth application.
// Keep this protocol in sync with cloudflare/gateway.mjs.
type gatewayIdentityKey struct{}
type gatewayIdentity struct{ Subject, Email, ClientIP string }

func loadGatewaySecret(path string) ([]byte, error) {
	if path == "" {
		return nil, nil
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, errors.New("无法读取网关密钥文件")
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() || st.Mode().Perm()&0077 != 0 || st.Size() > 128 {
		return nil, errors.New("网关密钥必须是权限 0600 的小型普通文件")
	}
	b, err := io.ReadAll(io.LimitReader(f, 129))
	if err != nil {
		return nil, errors.New("无法读取网关密钥文件")
	}
	secret, err := hex.DecodeString(strings.TrimSpace(string(b)))
	if err != nil || len(secret) != 32 {
		return nil, errors.New("网关密钥必须是 64 位十六进制字符串")
	}
	return secret, nil
}

func (a *App) gatewayRequest(w http.ResponseWriter, r *http.Request) (*http.Request, bool) {
	// Local maintenance is independent of Access and the public gateway. Never
	// expose these paths through Caddy or Pages; no forwarded headers authorize it.
	if r.URL.Path == "/readyz" || r.URL.Path == "/healthz" {
		host, _, _ := net.SplitHostPort(r.RemoteAddr)
		peer, err := netip.ParseAddr(host)
		if err == nil && peer.IsLoopback() && (r.Method == "GET" || r.Method == "HEAD") {
			base := strings.TrimPrefix(a.C.BaseURL, "https://")
			r.Host = base
			return r, true
		}
		a.problem(w, r, 403, "gateway_denied", "此路由仅供本机维护")
		return r, false
	}
	deny := func() (*http.Request, bool) {
		a.problem(w, r, 403, "gateway_denied", "请求未通过网关验证")
		return r, false
	}
	if !strings.HasPrefix(r.URL.Path, "/api/v1/") {
		return deny()
	}
	// These routes transfer local file bytes; the Pages deployment is R2-only.
	if strings.HasPrefix(r.URL.Path, "/api/v1/downloads/") || (r.Method == "PATCH" && strings.HasPrefix(r.URL.Path, "/api/v1/uploads/")) {
		a.problem(w, r, 409, "direct_transfer_required", "此部署仅支持 R2 文件直传")
		return r, false
	}
	fields := []string{"X-Parcel-Timestamp", "X-Parcel-Nonce", "X-Parcel-Subject", "X-Parcel-Email", "X-Parcel-Client-IP", "X-Parcel-Body-SHA256", "X-Parcel-Signature"}
	for _, name := range fields {
		values := r.Header.Values(name)
		if len(values) != 1 || len(values[0]) > 512 || strings.ContainsAny(values[0], "\r\n") {
			return deny()
		}
	}
	timestamp := r.Header.Get(fields[0])
	ts, err := strconv.ParseInt(timestamp, 10, 64)
	now := a.now().Unix()
	if err != nil || ts < now-60 || ts > now+15 {
		return deny()
	}
	nonce := r.Header.Get(fields[1])
	if !isSafeID(nonce) {
		return deny()
	}
	identity := gatewayIdentity{Subject: r.Header.Get(fields[2]), Email: r.Header.Get(fields[3]), ClientIP: r.Header.Get(fields[4])}
	ip, err := netip.ParseAddr(identity.ClientIP)
	if err != nil || ip.Zone() != "" || ip.IsUnspecified() || ip.IsMulticast() || (identity.Subject == "") != (identity.Email == "") {
		return deny()
	}
	bodyHash := r.Header.Get(fields[5])
	grantCookie := gatewayGrantCookie(r)
	canonical := strings.Join([]string{"parcel-gateway-v1", timestamp, nonce, r.Method, r.URL.RequestURI(), a.C.BaseURL,
		identity.Subject, identity.Email, identity.ClientIP, bodyHash, r.Header.Get("Content-Type"),
		r.Header.Get("X-CSRF-Token"), r.Header.Get("Idempotency-Key"), grantCookie}, "\n")
	mac := hmac.New(sha256.New, a.gatewaySecret)
	mac.Write([]byte(canonical))
	signature, err := hex.DecodeString(r.Header.Get(fields[6]))
	if err != nil || !hmac.Equal(signature, mac.Sum(nil)) {
		return deny()
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64<<10))
	if err != nil {
		a.jsonReadProblem(w, r, err)
		return r, false
	}
	digest := sha256.Sum256(body)
	if bodyHash != hex.EncodeToString(digest[:]) || !a.allow("gateway:"+nonce, 1, 2*time.Minute) {
		return deny()
	}
	r.Body = io.NopCloser(bytes.NewReader(body))
	r.Header.Del("Cookie")
	if grantCookie != "" {
		r.Header.Set("Cookie", grantCookie)
	}
	return r.WithContext(context.WithValue(r.Context(), gatewayIdentityKey{}, identity)), true
}

// Match the edge's cookie selection. Origin Access can inject CF_Authorization
// after signing; only the current share's grant belongs to the signed protocol.
func gatewayGrantCookie(r *http.Request) string {
	if !strings.HasPrefix(r.URL.Path, "/api/v1/shares/") {
		return ""
	}
	id := strings.SplitN(strings.TrimPrefix(r.URL.Path, "/api/v1/shares/"), "/", 2)[0]
	if !isSafeID(id) {
		return ""
	}
	for _, part := range strings.Split(r.Header.Get("Cookie"), ";") {
		cookie := strings.TrimSpace(part)
		if strings.HasPrefix(cookie, "parcel_grant_"+id+"=") {
			return cookie
		}
	}
	return ""
}

func (a *App) accessCSRF(identity gatewayIdentity) string {
	mac := hmac.New(sha256.New, a.gatewaySecret)
	mac.Write([]byte("parcel-access-csrf-v1\n" + identity.Subject + "\n" + identity.Email))
	return hex.EncodeToString(mac.Sum(nil))
}
func (a *App) validAccessCSRF(r *http.Request, identity gatewayIdentity) bool {
	return hmac.Equal([]byte(r.Header.Get("X-CSRF-Token")), []byte(a.accessCSRF(identity)))
}
