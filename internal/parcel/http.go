package parcel

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"
)

func (a *App) Handler() http.Handler {
	m := http.NewServeMux()
	m.HandleFunc("POST /api/v1/auth/login", a.login)
	m.HandleFunc("GET /api/v1/auth/session", a.session)
	m.HandleFunc("POST /api/v1/auth/logout", a.admin(a.logout))
	m.HandleFunc("GET /api/v1/admin/status", a.admin(a.status))
	m.HandleFunc("POST /api/v1/uploads", a.admin(a.createUpload))
	m.HandleFunc("GET /api/v1/uploads/lookup", a.admin(a.lookupUpload))
	m.HandleFunc("GET /api/v1/uploads/{id}", a.admin(a.getUpload))
	m.HandleFunc("PATCH /api/v1/uploads/{id}", a.admin(a.patchUpload))
	m.HandleFunc("POST /api/v1/uploads/{id}/complete", a.admin(a.completeUpload))
	m.HandleFunc("DELETE /api/v1/uploads/{id}", a.admin(a.cancelUpload))
	m.HandleFunc("GET /api/v1/admin/shares", a.admin(a.listShares))
	m.HandleFunc("GET /api/v1/admin/shares/{id}", a.admin(a.getAdminShare))
	m.HandleFunc("PATCH /api/v1/admin/shares/{id}/password", a.admin(a.changePassword))
	m.HandleFunc("DELETE /api/v1/admin/shares/{id}", a.admin(a.revoke))
	m.HandleFunc("GET /api/v1/shares/{id}", a.getShare)
	m.HandleFunc("POST /api/v1/shares/{id}/unlock", a.unlock)
	m.HandleFunc("POST /api/v1/shares/{id}/download-sessions", a.issueDownload)
	m.HandleFunc("GET /api/v1/downloads/{ticket}/file", a.download)
	m.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { jsonOK(w, 200, map[string]string{"status": "ok"}) })
	m.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		if e := a.diskReady(); e != nil {
			a.problem(w, r, 503, "not_ready", "数据目录或数据库不可用")
			return
		}
		jsonOK(w, 200, map[string]string{"status": "ready"})
	})
	m.HandleFunc("/", a.frontend)
	u, _ := url.Parse(a.C.BaseURL)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := randomToken()
		w.Header().Set("X-Request-ID", id)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "private, no-store")
		}
		if !strings.EqualFold(r.Host, u.Host) {
			a.problem(w, r, 403, "host_denied", "访问地址不受信任")
			return
		}
		if r.Method != "GET" && r.Method != "HEAD" {
			if r.Header.Get("Origin") != a.C.BaseURL {
				a.problem(w, r, 403, "origin_denied", "请求来源不受信任")
				return
			}
		}
		defer func() {
			if p := recover(); p != nil {
				a.log.Error("request panic", "request_id", id, "panic", fmt.Sprint(p))
				a.problem(w, r, 500, "internal_error", "服务暂时不可用")
			}
		}()
		start := time.Now()
		m.ServeHTTP(w, r)
		a.log.Debug("request", "request_id", id, "method", r.Method, "route", r.Pattern, "duration", time.Since(start))
	})
}
func jsonOK(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func (a *App) problem(w http.ResponseWriter, r *http.Request, status int, code, message string) {
	jsonOK(w, status, map[string]string{"code": code, "message": message, "request_id": w.Header().Get("X-Request-ID")})
}
func (a *App) internal(w http.ResponseWriter, r *http.Request, e error) {
	a.log.Error("operation failed", "request_id", w.Header().Get("X-Request-ID"), "error", e)
	a.problem(w, r, 500, "internal_error", "服务暂时不可用，请查看服务日志")
}
func (a *App) decode(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if e := d.Decode(v); e != nil {
		a.problem(w, r, 400, "invalid_json", "请求格式不正确")
		return false
	}
	var extra any
	if e := d.Decode(&extra); e != io.EOF {
		a.problem(w, r, 400, "invalid_json", "请求只能包含一个 JSON 对象")
		return false
	}
	return true
}
func (a *App) frontend(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" && r.Method != "HEAD" {
		a.problem(w, r, 405, "method_not_allowed", "请求方法不支持")
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/") {
		a.problem(w, r, 404, "not_found", "接口不存在")
		return
	}
	if a.static == nil {
		a.problem(w, r, 503, "frontend_missing", "请先构建前端")
		return
	}
	p := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
	if p == "" || p == "." {
		p = "index.html"
	}
	if _, e := fs.Stat(a.static, p); e != nil {
		if strings.HasPrefix(p, "assets/") {
			http.NotFound(w, r)
			return
		}
		p = "index.html"
	}
	if p == "index.html" {
		b, e := fs.ReadFile(a.static, p)
		if e != nil {
			a.internal(w, r, e)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		if r.Method != "HEAD" {
			w.Write(b)
		}
		return
	}
	http.FileServer(http.FS(a.static)).ServeHTTP(w, r)
}
func (a *App) allow(key string, n int, period time.Duration) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	now := a.now()
	v := a.limits[key]
	if !now.Before(v.until) {
		v = limitEntry{until: now.Add(period)}
	}
	if len(a.limits) >= 10000 {
		for k, v := range a.limits {
			if !now.Before(v.until) {
				delete(a.limits, k)
			}
		}
		if len(a.limits) >= 10000 {
			return false
		}
	}
	v.count++
	a.limits[key] = v
	return v.count <= n
}
func (a *App) rate(w http.ResponseWriter, r *http.Request, key string, n int, period time.Duration) bool {
	if !a.allow(key, n, period) {
		w.Header().Set("Retry-After", "60")
		a.problem(w, r, 429, "rate_limited", "请求过于频繁，请稍后重试")
		return false
	}
	return true
}
func isSafeID(s string) bool {
	if len(s) != 32 {
		return false
	}
	for _, c := range s {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-') {
			return false
		}
	}
	return true
}

var errUnavailable = errors.New("download not permitted")
