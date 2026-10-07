package parcel

import (
	"bytes"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/netip"
	"net/url"
	"strings"
	"testing"

	"github.com/hyphy-void/Parcel/internal/config"
)

func TestClientIPTrustBoundary(t *testing.T) {
	proxies := []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32"), netip.MustParsePrefix("::1/128"), netip.MustParsePrefix("10.0.0.0/24")}
	for _, tc := range []struct {
		name, peer, header, want string
		trust                    bool
	}{
		{"default ignores headers", "127.0.0.1:80", "198.51.100.2", "127.0.0.1", false},
		{"untrusted peer", "198.51.100.1:80", "127.0.0.1", "198.51.100.1", true},
		{"trusted peer", "127.0.0.1:80", "198.51.100.2", "198.51.100.2", true},
		{"spoofed left entry", "127.0.0.1:80", "192.168.1.1, 198.51.100.2", "198.51.100.2", true},
		{"trusted chain", "127.0.0.1:80", "198.51.100.2, 10.0.0.2", "198.51.100.2", true},
		{"ipv6", "[::1]:80", "2001:db8::2", "2001:db8::2", true},
		{"mapped ipv4", "[::ffff:127.0.0.1]:80", "::ffff:198.51.100.2", "198.51.100.2", true},
		{"canonical ipv6", "[::1]:80", "2001:0db8:0:0:0:0:0:2", "2001:db8::2", true},
		{"missing header", "127.0.0.1:80", "", "127.0.0.1", true},
		{"malformed nearest hop", "127.0.0.1:80", "198.51.100.2, bad", "127.0.0.1", true},
		{"empty hop", "127.0.0.1:80", "198.51.100.2,", "127.0.0.1", true},
		{"port forbidden", "127.0.0.1:80", "198.51.100.2:80", "127.0.0.1", true},
		{"zone forbidden", "127.0.0.1:80", "fe80::1%eth0", "127.0.0.1", true},
		{"unspecified forbidden", "127.0.0.1:80", "::", "127.0.0.1", true},
		{"oversized header", "127.0.0.1:80", strings.Repeat("a", 4097), "127.0.0.1", true},
		{"too many hops", "127.0.0.1:80", strings.Repeat("10.0.0.1,", 32) + "198.51.100.2", "127.0.0.1", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := &App{C: config.Config{}}
			if tc.trust {
				a.C.TrustedProxies = proxies
			}
			r := httptest.NewRequest("GET", "http://parcel.example", nil)
			r.RemoteAddr = tc.peer
			r.Header.Set("X-Forwarded-For", tc.header)
			r.Header.Set("X-Real-IP", "192.168.1.1")
			r.Header.Set("Forwarded", "for=192.168.1.1")
			if got := a.clientIP(r); got != tc.want {
				t.Fatalf("got %q want %q", got, tc.want)
			}
		})
	}
	a := &App{C: config.Config{TrustedProxies: proxies}}
	r := httptest.NewRequest("GET", "http://parcel.example", nil)
	r.RemoteAddr = "127.0.0.1:80"
	r.Header.Add("X-Forwarded-For", "192.168.1.1")
	r.Header.Add("X-Forwarded-For", "198.51.100.2")
	if got := a.clientIP(r); got != "198.51.100.2" {
		t.Fatal(got)
	}
}

func TestProxyRateLimitsSeparateClientsAndRejectSpoofing(t *testing.T) {
	f := testApp(t)
	f.a.C.TrustedProxies = []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32")}
	request := func(peer, forwarded string) int {
		r := httptest.NewRequest("POST", f.a.C.BaseURL+"/api/v1/auth/login", strings.NewReader("{}"))
		r.RemoteAddr = peer
		r.Header.Set("Origin", f.a.C.BaseURL)
		r.Header.Set("X-Forwarded-For", forwarded)
		w := httptest.NewRecorder()
		f.h.ServeHTTP(w, r)
		return w.Code
	}
	for i := 0; i < 5; i++ {
		if code := request("127.0.0.1:80", "198.51.100.1"); code != 401 {
			t.Fatal(code)
		}
	}
	if code := request("127.0.0.1:80", "198.51.100.1"); code != 429 {
		t.Fatal(code)
	}
	if code := request("127.0.0.1:80", "198.51.100.2"); code != 401 {
		t.Fatal(code)
	}
	if code := request("127.0.0.1:80", "198.51.100.3, 198.51.100.1"); code != 429 {
		t.Fatal(code)
	}
	for i := 0; i < 5; i++ {
		if code := request("198.51.100.4:80", "198.51.100.2"); code != 401 {
			t.Fatal(code)
		}
	}
	if code := request("198.51.100.4:80", "198.51.100.5"); code != 429 {
		t.Fatal(code)
	}
}

// This exercises real TLS at the entry and plain HTTP at the backend without
// depending on a deployment configuration or external certificate authority.
func TestHTTPSReverseProxy(t *testing.T) {
	for _, network := range []string{"tcp4", "tcp6"} {
		t.Run(network, func(t *testing.T) { testHTTPSReverseProxy(t, network) })
	}
}

func testHTTPSReverseProxy(t *testing.T, network string) {
	address := "127.0.0.1:0"
	if network == "tcp6" {
		address = "[::1]:0"
	}
	listener, err := net.Listen(network, address)
	if err != nil {
		if network == "tcp6" {
			t.Skipf("IPv6 loopback unavailable: %v", err)
		}
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	f := testApp(t)
	f.a.C.BaseURL = "https://parcel.example"
	f.a.C.TrustedProxies = []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32")}
	f.h = f.a.Handler()
	data := []byte("private file through HTTPS proxy")
	s := f.publish(t, data, "", 1)
	ticket := f.ticket(t, s.ID, nil)
	backend := httptest.NewServer(f.h)
	defer backend.Close()
	upstream, _ := url.Parse(backend.URL)
	proxy := &httputil.ReverseProxy{Rewrite: func(pr *httputil.ProxyRequest) {
		pr.SetURL(upstream)
		pr.Out.Host = pr.In.Host
		pr.SetXForwarded()
	}}
	entry := httptest.NewUnstartedServer(proxy)
	entry.Listener.Close()
	entry.Listener = listener
	entry.StartTLS()
	defer entry.Close()
	request := func(method, path, body string, headers map[string]string) (*http.Response, []byte) {
		t.Helper()
		r, err := http.NewRequest(method, entry.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		r.Host = "parcel.example"
		r.Header.Set("Origin", f.a.C.BaseURL)
		for key, value := range headers {
			if key == "Host" {
				r.Host = value
			} else {
				r.Header.Set(key, value)
			}
		}
		resp, err := entry.Client().Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		return resp, b
	}
	resp, _ := request("POST", "/api/v1/auth/login", `{"password":"test-password"}`, nil)
	if resp.StatusCode != 200 {
		t.Fatal(resp.StatusCode)
	}
	cookies := resp.Cookies()
	if len(cookies) != 1 || !cookies[0].Secure || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteStrictMode {
		t.Fatalf("insecure cookie: %v", cookies)
	}
	resp, _ = request("POST", "/api/v1/auth/login", `{}`, map[string]string{"Origin": "https://evil.example", "X-Forwarded-Host": "parcel.example"})
	if resp.StatusCode != 403 {
		t.Fatal("origin accepted", resp.StatusCode)
	}
	resp, _ = request("GET", "/api/v1/admin/status", "", map[string]string{"Host": "evil.example", "X-Forwarded-Host": "parcel.example"})
	if resp.StatusCode != 403 {
		t.Fatal("host accepted", resp.StatusCode)
	}
	resp, first := request("GET", ticket, "", map[string]string{"Range": "bytes=0-6"})
	if resp.StatusCode != 206 || !bytes.Equal(first, data[:7]) || resp.Header.Get("Cache-Control") != "private, no-store" {
		t.Fatalf("first range: %d %s", resp.StatusCode, first)
	}
	resp, rest := request("GET", ticket, "", map[string]string{"Range": "bytes=7-"})
	if resp.StatusCode != 206 || !bytes.Equal(rest, data[7:]) {
		t.Fatalf("resume: %d %s", resp.StatusCode, rest)
	}
	count(t, f.a, s.ID, 1)
	resp, _ = request("DELETE", "/api/v1/admin/shares/"+s.ID, "", map[string]string{"Cookie": f.cookie.String(), "X-CSRF-Token": f.csrf})
	if resp.StatusCode != 200 {
		t.Fatal("revoke failed", resp.StatusCode)
	}
	resp, _ = request("GET", ticket, "", nil)
	if resp.StatusCode != 410 {
		t.Fatal("revoked ticket accepted", resp.StatusCode)
	}
}
