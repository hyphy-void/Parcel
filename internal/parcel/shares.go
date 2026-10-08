package parcel

import (
	"net/http"
	"strconv"
	"time"
)

func (a *App) listShares(w http.ResponseWriter, r *http.Request) {
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	if page < 1 {
		page = 1
	}
	if page > 100000 {
		a.problem(w, r, 400, "invalid_page", "页码不合法")
		return
	}
	rows, e := a.db.Query("SELECT "+shareColumns+" FROM shares ORDER BY created DESC,id LIMIT 20 OFFSET ?", (page-1)*20)
	if e != nil {
		a.internal(w, r, e)
		return
	}
	shares := []Share{}
	for rows.Next() {
		s, e := scanShare(rows)
		if e != nil {
			rows.Close()
			a.internal(w, r, e)
			return
		}
		s.Availability = a.availability(s)
		s.URL = a.C.BaseURL + "/s/" + s.ID
		shares = append(shares, s)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		a.internal(w, r, e)
		return
	}
	var total int
	if e = a.db.QueryRow("SELECT count(*) FROM shares").Scan(&total); e != nil {
		a.internal(w, r, e)
		return
	}
	var cleaned int
	if e = a.db.QueryRow("SELECT count(*) FROM shares WHERE state='deleted'").Scan(&cleaned); e != nil {
		a.internal(w, r, e)
		return
	}
	jsonOK(w, 200, map[string]any{"items": shares, "total": total, "page": page, "cleaned_count": cleaned})
}

// File cleanup is authoritative: expired/revoked objects still retained or
// awaiting deletion must keep their metadata and quota accounting.
func (a *App) clearCleanedShares(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	defer a.mu.Unlock()
	result, err := a.db.Exec("DELETE FROM shares WHERE state='deleted'")
	if err != nil {
		a.internal(w, r, err)
		return
	}
	n, _ := result.RowsAffected()
	a.audit("cleaned_history_cleared", "shares", "ok")
	jsonOK(w, 200, map[string]any{"removed": n})
}

func (a *App) getAdminShare(w http.ResponseWriter, r *http.Request) {
	s, e := a.share(r.PathValue("id"))
	if e != nil {
		a.problem(w, r, 404, "not_found", "分享不存在")
		return
	}
	jsonOK(w, 200, s)
}
func (a *App) granted(r *http.Request, s Share) bool {
	if s.PasswordHash == "" {
		return true
	}
	c, e := r.Cookie("parcel_grant_" + s.ID)
	if e != nil {
		return false
	}
	var n int
	e = a.db.QueryRow("SELECT count(*) FROM share_grants WHERE token_hash=? AND share_id=? AND version=? AND expires>?", tokenHash(c.Value), s.ID, s.Version, a.now().Unix()).Scan(&n)
	return e == nil && n == 1
}
func (a *App) getShare(w http.ResponseWriter, r *http.Request) {
	s, e := a.share(r.PathValue("id"))
	if e != nil {
		a.problem(w, r, 404, "not_found", "分享不存在")
		return
	}
	if !a.granted(r, s) {
		jsonOK(w, 200, map[string]any{"id": s.ID, "password_required": true, "locked": true, "availability": s.Availability})
		return
	}
	jsonOK(w, 200, s)
}
func (a *App) unlock(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !a.rate(w, r, "unlock-ip:"+a.clientIP(r), 10, time.Minute) || !a.rate(w, r, "unlock-share:"+id, 20, time.Minute) {
		return
	}
	var req struct {
		Password string `json:"password"`
	}
	if !a.decode(w, r, &req) {
		return
	}
	s, e := a.share(id)
	if e != nil {
		a.problem(w, r, 404, "not_found", "分享不存在")
		return
	}
	if s.State != "active" || s.Expires <= a.now().Unix() {
		a.problem(w, r, 410, "share_expired", "分享已失效")
		return
	}
	select {
	case a.hashSlots <- struct{}{}:
		defer func() { <-a.hashSlots }()
	default:
		a.problem(w, r, 503, "busy", "密码验证繁忙")
		return
	}
	if s.PasswordHash != "" && !checkPassword(req.Password, s.PasswordHash) {
		a.problem(w, r, 401, "invalid_password", "分享密码不正确")
		return
	}
	token := randomToken()
	a.mu.Lock()
	fresh, e := a.share(id)
	if e == nil && (fresh.Version != s.Version || fresh.State != "active" || fresh.Expires <= a.now().Unix()) {
		e = errUnavailable
	}
	if e == nil {
		_, e = a.db.Exec("INSERT INTO share_grants(token_hash,share_id,version,expires) VALUES(?,?,?,?)", tokenHash(token), id, s.Version, a.now().Add(30*time.Minute).Unix())
	}
	a.mu.Unlock()
	if e != nil {
		a.problem(w, r, 410, "share_expired", "分享权限已经改变，请重新打开链接")
		return
	}
	a.setCookie(w, "parcel_grant_"+id, token, "/api/v1/shares/"+id, 30*time.Minute)
	jsonOK(w, 200, s)
}
func (a *App) revoke(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	a.mu.Lock()
	defer a.mu.Unlock()
	s, e := a.share(id)
	if e != nil {
		a.problem(w, r, 404, "not_found", "分享不存在")
		return
	}
	if s.State == "deleted" {
		jsonOK(w, 200, map[string]bool{"ok": true})
		return
	}
	tx, e := a.db.Begin()
	if e != nil {
		a.internal(w, r, e)
		return
	}
	defer tx.Rollback()
	if _, e = tx.Exec("UPDATE shares SET state='revoked',version=version+1 WHERE id=?", id); e == nil {
		_, e = tx.Exec("UPDATE download_sessions SET state='revoked' WHERE share_id=?", id)
	}
	if e == nil {
		_, e = tx.Exec("DELETE FROM share_grants WHERE share_id=?", id)
	}
	if e == nil {
		e = tx.Commit()
	}
	if e != nil {
		a.internal(w, r, e)
		return
	}
	for _, v := range a.streams[id] {
		v.cancel()
		v.interrupt()
	}
	a.audit("share_revoked", id, "ok")
	jsonOK(w, 200, map[string]bool{"ok": true})
}
func (a *App) changePassword(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Password string `json:"password"`
	}
	if !a.decode(w, r, &req) {
		return
	}
	var hash string
	var e error
	if req.Password != "" {
		select {
		case a.hashSlots <- struct{}{}:
		default:
			a.problem(w, r, 503, "busy", "密码处理繁忙")
			return
		}
		hash, e = hashSharePassword(req.Password)
		<-a.hashSlots
		if e != nil {
			a.problem(w, r, 400, "invalid_password", e.Error())
			return
		}
	}
	id := r.PathValue("id")
	a.mu.Lock()
	defer a.mu.Unlock()
	s, e := a.share(id)
	if e != nil {
		a.problem(w, r, 404, "not_found", "分享不存在")
		return
	}
	if s.State != "active" || s.Expires <= a.now().Unix() {
		a.problem(w, r, 410, "share_expired", "分享已失效")
		return
	}
	tx, e := a.db.Begin()
	if e != nil {
		a.internal(w, r, e)
		return
	}
	defer tx.Rollback()
	if _, e = tx.Exec("UPDATE shares SET password_hash=?,version=version+1 WHERE id=?", hash, id); e == nil {
		_, e = tx.Exec("UPDATE download_sessions SET state='revoked' WHERE share_id=?", id)
	}
	if e == nil {
		_, e = tx.Exec("DELETE FROM share_grants WHERE share_id=?", id)
	}
	if e == nil {
		e = tx.Commit()
	}
	if e != nil {
		a.internal(w, r, e)
		return
	}
	for _, v := range a.streams[id] {
		v.cancel()
		v.interrupt()
	}
	a.audit("share_password_changed", id, "ok")
	jsonOK(w, 200, map[string]bool{"ok": true})
}
func (a *App) issueDownload(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !a.rate(w, r, "ticket-ip:"+a.clientIP(r), 30, time.Minute) {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	s, e := a.share(id)
	if e != nil {
		a.problem(w, r, 404, "not_found", "分享不存在")
		return
	}
	if !a.granted(r, s) {
		a.problem(w, r, 401, "share_locked", "请先验证分享密码")
		return
	}
	if a.availability(s) != "available" {
		a.problem(w, r, 410, "share_unavailable", "分享已失效或下载次数已用完")
		return
	}
	if s.Backend == "r2" {
		a.issueR2(w, r, s)
		return
	}
	var n int
	if e = a.db.QueryRow("SELECT count(*) FROM download_sessions WHERE share_id=? AND state='issued' AND expires>?", id, a.now().Unix()).Scan(&n); e != nil {
		a.internal(w, r, e)
		return
	}
	if n >= 100 {
		a.problem(w, r, 429, "too_many_tickets", "下载请求过多，请稍后重试")
		return
	}
	token := randomToken()
	expires := a.now().Add(10 * time.Minute).Unix()
	_, e = a.db.Exec("INSERT INTO download_sessions(token_hash,share_id,version,created,last_activity,expires) VALUES(?,?,?,?,?,?)", tokenHash(token), id, s.Version, a.now().Unix(), a.now().Unix(), expires)
	if e != nil {
		a.internal(w, r, e)
		return
	}
	jsonOK(w, 201, map[string]any{"url": "/api/v1/downloads/" + token + "/file", "expires": expires, "max_ttl_seconds": int64(a.C.DownloadMax.Seconds())})
}
