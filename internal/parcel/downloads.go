package parcel

import (
	"context"
	"errors"
	"fmt"
	"mime"
	"net/http"
	"os"
	"strings"
	"time"
)

type downloadSession struct {
	ShareID                  string
	Version                  int
	State                    string
	Expires, Activated, Last int64
}

func (a *App) downloadSession(hash string) (d downloadSession, e error) {
	e = a.db.QueryRow("SELECT share_id,version,state,expires,activated,last_activity FROM download_sessions WHERE token_hash=?", hash).Scan(&d.ShareID, &d.Version, &d.State, &d.Expires, &d.Activated, &d.Last)
	return
}
func (a *App) validSession(d downloadSession, s Share) bool {
	now := a.now().Unix()
	return s.State == "active" && s.Expires > now && d.Version == s.Version && (d.State == "issued" || d.State == "active") && d.Expires > now && (d.State != "active" || d.Last+int64(a.C.DownloadIdle.Seconds()) > now)
}
func (a *App) activate(hash string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	d, e := a.downloadSession(hash)
	if e != nil {
		return e
	}
	s, e := a.share(d.ShareID)
	if e != nil {
		return e
	}
	if !a.validSession(d, s) {
		return errUnavailable
	}
	tx, e := a.db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	now := a.now().Unix()
	if d.State == "issued" {
		result, e := tx.Exec("UPDATE shares SET download_count=download_count+1 WHERE id=? AND state='active' AND version=? AND expires>? AND download_count<max_downloads", s.ID, s.Version, now)
		if e != nil {
			return e
		}
		n, e := result.RowsAffected()
		if e != nil {
			return e
		}
		if n != 1 {
			return errUnavailable
		}
		_, e = tx.Exec("UPDATE download_sessions SET state='active',activated=?,last_activity=?,expires=? WHERE token_hash=? AND state='issued'", now, now, a.now().Add(a.C.DownloadMax).Unix(), hash)
		if e != nil {
			return e
		}
	} else {
		if _, e = tx.Exec("UPDATE download_sessions SET last_activity=? WHERE token_hash=?", now, hash); e != nil {
			return e
		}
	}
	return tx.Commit()
}

// gatedWriter commits the download admission before ServeContent emits a 200/206.
// Error and conditional responses bypass admission; a failed admission never sends file bytes.
type gatedWriter struct {
	http.ResponseWriter
	a         *App
	request   *http.Request
	hash      string
	ctl       *http.ResponseController
	ctx       context.Context
	header    bool
	blocked   bool
	lastTouch time.Time
	content   bool
	absolute  int64
}

func (g *gatedWriter) Unwrap() http.ResponseWriter { return g.ResponseWriter }
func (g *gatedWriter) WriteHeader(status int) {
	if g.header {
		return
	}
	g.header = true
	if g.request.Method != "HEAD" && (status == 200 || status == 206) {
		if e := g.a.activate(g.hash); e != nil {
			g.blocked = true
			for _, key := range []string{"Content-Length", "Content-Range", "Content-Disposition", "Content-Type", "ETag", "Last-Modified", "Accept-Ranges"} {
				g.Header().Del(key)
			}
			if errors.Is(e, errUnavailable) {
				g.a.problem(g.ResponseWriter, g.request, 410, "download_unavailable", "下载资格已失效或次数已用完")
			} else {
				g.a.internal(g.ResponseWriter, g.request, e)
			}
			return
		}
		d, e := g.a.downloadSession(g.hash)
		if e != nil {
			g.blocked = true
			g.a.internal(g.ResponseWriter, g.request, e)
			return
		}
		g.content = true
		g.absolute = d.Expires
		g.Header().Set("X-Download-Session-State", d.State)
		g.Header().Set("X-Download-Session-Expires", fmt.Sprint(d.Expires))
	}
	g.ResponseWriter.WriteHeader(status)
}
func (g *gatedWriter) Write(b []byte) (int, error) {
	if !g.header {
		g.WriteHeader(200)
	}
	if g.blocked {
		return 0, errUnavailable
	}
	if e := g.ctx.Err(); e != nil {
		return 0, e
	}
	if g.content && g.absolute <= g.a.now().Unix() {
		return 0, errUnavailable
	}
	if g.content && time.Since(g.lastTouch) > 15*time.Second {
		g.a.mu.Lock()
		_, e := g.a.db.Exec("UPDATE download_sessions SET last_activity=? WHERE token_hash=? AND state='active'", g.a.now().Unix(), g.hash)
		g.a.mu.Unlock()
		if e != nil {
			return 0, e
		}
		g.lastTouch = time.Now()
	}
	deadline := time.Now().Add(30 * time.Second)
	if g.content {
		absolute := time.Now().Add(time.Duration(g.absolute-g.a.now().Unix()) * time.Second)
		if absolute.Before(deadline) {
			deadline = absolute
		}
	}
	_ = g.ctl.SetWriteDeadline(deadline)
	return g.ResponseWriter.Write(b)
}
func (a *App) download(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("ticket")
	if !isSafeID(token) {
		a.problem(w, r, 404, "not_found", "下载不存在")
		return
	}
	hash := tokenHash(token)
	if len(r.Header.Get("Range")) > 128 || strings.Contains(r.Header.Get("Range"), ",") {
		a.problem(w, r, 416, "invalid_range", "仅支持单个下载范围")
		return
	}
	a.mu.Lock()
	d, e := a.downloadSession(hash)
	if e != nil {
		a.mu.Unlock()
		a.problem(w, r, 401, "invalid_ticket", "下载凭证无效")
		return
	}
	s, e := a.share(d.ShareID)
	if e != nil || !a.validSession(d, s) || (d.State == "issued" && s.DownloadCount >= s.MaxDownloads) {
		a.mu.Unlock()
		a.problem(w, r, 410, "download_unavailable", "下载凭证或分享已失效")
		return
	}
	if s.Backend == "r2" {
		a.mu.Unlock()
		a.problem(w, r, 409, "direct_download_required", "请重新获取 R2 下载地址")
		return
	}
	active := 0
	for _, v := range a.streams {
		active += len(v)
	}
	if active >= 4 {
		a.mu.Unlock()
		w.Header().Set("Retry-After", "2")
		a.problem(w, r, 503, "download_busy", "下载繁忙，请稍后重试")
		return
	}
	f, e := a.root.Open("files/" + s.StorageKey)
	if e != nil {
		if errors.Is(e, os.ErrNotExist) {
			_, _ = a.db.Exec("UPDATE shares SET state='missing',error='存储文件缺失' WHERE id=?", s.ID)
		}
		a.mu.Unlock()
		a.problem(w, r, 410, "file_missing", "文件暂不可用")
		return
	}
	st, e := f.Stat()
	if e != nil || st.Size() != s.Size {
		f.Close()
		a.mu.Unlock()
		a.problem(w, r, 410, "file_missing", "文件校验信息不一致")
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	ctl := http.NewResponseController(w)
	key := randomToken()
	if a.streams[s.ID] == nil {
		a.streams[s.ID] = map[string]stream{}
	}
	a.streams[s.ID][key] = stream{cancel: cancel, interrupt: func() { _ = ctl.SetWriteDeadline(time.Now()) }}
	a.wg.Add(1)
	a.mu.Unlock()
	defer func() {
		cancel()
		f.Close()
		a.mu.Lock()
		delete(a.streams[s.ID], key)
		if len(a.streams[s.ID]) == 0 {
			delete(a.streams, s.ID)
		}
		a.mu.Unlock()
		_ = ctl.SetWriteDeadline(time.Time{})
		a.wg.Done()
	}()
	timeout := a.C.DownloadMax
	if d.State == "active" {
		timeout = time.Duration(d.Expires-a.now().Unix()) * time.Second
	}
	timer := time.AfterFunc(timeout, func() { cancel(); _ = ctl.SetWriteDeadline(time.Now()) })
	defer timer.Stop()
	w.Header().Set("X-Download-Session-State", d.State)
	w.Header().Set("X-Download-Session-Expires", fmt.Sprint(d.Expires))
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": s.Name}))
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("ETag", fmt.Sprintf("\"%s\"", s.SHA256))
	gate := &gatedWriter{ResponseWriter: w, a: a, request: r, hash: hash, ctl: ctl, ctx: ctx, lastTouch: time.Now()}
	http.ServeContent(gate, r, s.Name, time.Unix(s.Created, 0), f)
}
