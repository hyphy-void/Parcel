package parcel

import (
	"net/http"
	"time"

	"github.com/hyphy-void/Parcel/internal/r2"
)

// Caller holds a.mu. Authorization, count and URL lifetime bookkeeping commit
// together; signing failure never consumes a download.
func (a *App) issueR2(w http.ResponseWriter, r *http.Request, s Share) {
	address, err := a.r2.SignGet(r.Context(), s.StorageKey, s.Name)
	if err != nil {
		a.internal(w, r, err)
		return
	}
	token := randomToken()
	now := a.now().Unix()
	expires := a.now().Add(a.C.DownloadMax).Unix()
	signed := a.now().Add(r2.URLTTL).Unix()
	tx, err := a.db.Begin()
	if err != nil {
		a.internal(w, r, err)
		return
	}
	defer tx.Rollback()
	result, err := tx.Exec("UPDATE shares SET download_count=download_count+1,signed_until=max(signed_until,?) WHERE id=? AND state='active' AND expires>? AND download_count<max_downloads", max(expires, signed), s.ID, now)
	if err != nil {
		a.internal(w, r, err)
		return
	}
	n, _ := result.RowsAffected()
	if n != 1 {
		a.problem(w, r, 410, "share_unavailable", "分享已失效或下载次数已用完")
		return
	}
	_, err = tx.Exec("INSERT INTO download_sessions(token_hash,share_id,version,state,created,activated,last_activity,expires) VALUES(?,?,?,'active',?,?,?,?)", tokenHash(token), s.ID, s.Version, now, now, now, expires)
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		a.internal(w, r, err)
		return
	}
	jsonOK(w, 201, map[string]any{"url": address, "session": token, "expires": signed, "session_expires": expires, "max_ttl_seconds": int64(a.C.DownloadMax.Seconds())})
}
func (a *App) refreshDownload(w http.ResponseWriter, r *http.Request) {
	if !a.rate(w, r, "refresh:"+a.clientIP(r), 60, time.Minute) {
		return
	}
	var req struct {
		Session string `json:"session"`
	}
	if !a.decode(w, r, &req) {
		return
	}
	if !isSafeID(req.Session) {
		a.problem(w, r, 401, "invalid_ticket", "下载会话无效")
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	d, err := a.downloadSession(tokenHash(req.Session))
	if err != nil || d.ShareID != r.PathValue("id") {
		a.problem(w, r, 401, "invalid_ticket", "下载会话无效")
		return
	}
	s, err := a.share(d.ShareID)
	if err != nil || s.Backend != "r2" || !a.validSession(d, s) || d.State != "active" {
		a.problem(w, r, 410, "download_unavailable", "下载会话或分享已失效")
		return
	}
	address, err := a.r2.SignGet(r.Context(), s.StorageKey, s.Name)
	if err != nil {
		a.internal(w, r, err)
		return
	}
	signed := a.now().Add(r2.URLTTL).Unix()
	tx, err := a.db.Begin()
	if err != nil {
		a.internal(w, r, err)
		return
	}
	defer tx.Rollback()
	_, err = tx.Exec("UPDATE shares SET signed_until=max(signed_until,?) WHERE id=?", max(d.Expires, signed), s.ID)
	if err == nil {
		_, err = tx.Exec("UPDATE download_sessions SET last_activity=? WHERE token_hash=?", a.now().Unix(), tokenHash(req.Session))
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		a.internal(w, r, err)
		return
	}
	jsonOK(w, 200, map[string]any{"url": address, "session": req.Session, "expires": signed, "session_expires": d.Expires, "max_ttl_seconds": int64(a.C.DownloadMax.Seconds())})
}
