package parcel

import (
	"net/http"
	"net/url"
	"time"
)

func (a *App) setCookie(w http.ResponseWriter, name, value, path string, ttl time.Duration) {
	u, _ := url.Parse(a.C.BaseURL)
	http.SetCookie(w, &http.Cookie{Name: name, Value: value, Path: path, HttpOnly: true, Secure: u.Scheme == "https", SameSite: http.SameSiteStrictMode, MaxAge: int(ttl.Seconds()), Expires: a.now().Add(ttl)})
}
func (a *App) admin(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, e := r.Cookie("parcel_admin")
		if e != nil {
			a.problem(w, r, 401, "unauthorized", "请先登录")
			return
		}
		var csrf string
		var expiry int64
		e = a.db.QueryRow("SELECT s.csrf,s.expires FROM admin_sessions s JOIN admin_credentials c ON c.version=s.version WHERE s.token_hash=?", tokenHash(c.Value)).Scan(&csrf, &expiry)
		if e != nil || expiry <= a.now().Unix() {
			a.problem(w, r, 401, "unauthorized", "登录已失效，请重新登录")
			return
		}
		if r.Method != "GET" && r.Method != "HEAD" && r.Header.Get("X-CSRF-Token") != csrf {
			a.problem(w, r, 403, "csrf_denied", "请求验证失败，请刷新页面")
			return
		}
		next(w, r)
	}
}
func (a *App) login(w http.ResponseWriter, r *http.Request) {
	if !a.rate(w, r, "login:"+clientIP(r), 5, time.Minute) {
		return
	}
	var req struct {
		Password string `json:"password"`
	}
	if !a.decode(w, r, &req) {
		return
	}
	var hash string
	var version int
	if e := a.db.QueryRow("SELECT password_hash,version FROM admin_credentials WHERE id=1").Scan(&hash, &version); e != nil {
		a.problem(w, r, 503, "admin_not_initialized", "请先在服务器初始化管理员密码")
		return
	}
	select {
	case a.hashSlots <- struct{}{}:
		defer func() { <-a.hashSlots }()
	default:
		a.problem(w, r, 503, "busy", "密码验证繁忙，请稍后重试")
		return
	}
	if !checkPassword(req.Password, hash) {
		a.problem(w, r, 401, "invalid_password", "密码不正确")
		return
	}
	t, csrf := randomToken(), randomToken()
	a.mu.Lock()
	_, e := a.db.Exec("INSERT INTO admin_sessions(token_hash,csrf,expires,version) VALUES(?,?,?,?)", tokenHash(t), csrf, a.now().Add(12*time.Hour).Unix(), version)
	if e == nil {
		delete(a.limits, "login:"+clientIP(r))
		a.audit("login", "admin", "ok")
	}
	a.mu.Unlock()
	if e != nil {
		a.internal(w, r, e)
		return
	}
	a.setCookie(w, "parcel_admin", t, "/", 12*time.Hour)
	jsonOK(w, 200, map[string]any{"authenticated": true, "csrf": csrf})
}
func (a *App) session(w http.ResponseWriter, r *http.Request) {
	a.admin(func(w http.ResponseWriter, r *http.Request) {
		c, _ := r.Cookie("parcel_admin")
		var csrf string
		var expires int64
		if e := a.db.QueryRow("SELECT csrf,expires FROM admin_sessions WHERE token_hash=?", tokenHash(c.Value)).Scan(&csrf, &expires); e != nil {
			a.internal(w, r, e)
			return
		}
		jsonOK(w, 200, map[string]any{"authenticated": true, "csrf": csrf, "expires": expires})
	})(w, r)
}
func (a *App) logout(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Cookie("parcel_admin")
	a.mu.Lock()
	_, e := a.db.Exec("DELETE FROM admin_sessions WHERE token_hash=?", tokenHash(c.Value))
	a.mu.Unlock()
	if e != nil {
		a.internal(w, r, e)
		return
	}
	a.setCookie(w, "parcel_admin", "", "/", -time.Second)
	jsonOK(w, 200, map[string]bool{"ok": true})
}
