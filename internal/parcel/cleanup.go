package parcel

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"time"
)

func (a *App) recover() error {
	rows, e := a.db.Query("SELECT " + uploadColumns + " FROM uploads WHERE state IN ('created','uploading','finalizing')")
	if e != nil {
		return e
	}
	var uploads []Upload
	for rows.Next() {
		u, e := scanUpload(rows)
		if e != nil {
			rows.Close()
			return e
		}
		uploads = append(uploads, u)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	for _, u := range uploads {
		tmp := "tmp/" + u.ID + ".part"
		f, e := a.root.OpenFile(tmp, os.O_RDWR, 0600)
		if errors.Is(e, os.ErrNotExist) && u.State == "finalizing" {
			st, err := a.root.Lstat("files/" + u.StorageKey)
			if err == nil && st.Mode().IsRegular() && st.Size() == u.Size {
				continue
			}
		}
		if e == nil {
			st, err := f.Stat()
			if err != nil {
				e = err
			} else if st.Size() < u.Offset {
				e = fmt.Errorf("文件小于已确认偏移")
			} else if st.Size() > u.Offset {
				e = f.Truncate(u.Offset)
				if e == nil {
					e = f.Sync()
				}
			}
			f.Close()
		}
		if e != nil {
			if _, err := a.db.Exec("UPDATE uploads SET state='failed',error='上传文件不完整，无法恢复' WHERE id=?", u.ID); err != nil {
				return err
			}
			a.log.Warn("upload recovery failed", "upload_id", u.ID, "error", e)
		}
	}
	rows, e = a.db.Query("SELECT " + shareColumns + " FROM shares WHERE state='active'")
	if e != nil {
		return e
	}
	var shares []Share
	for rows.Next() {
		s, e := scanShare(rows)
		if e != nil {
			rows.Close()
			return e
		}
		shares = append(shares, s)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	for _, s := range shares {
		st, e := a.root.Lstat("files/" + s.StorageKey)
		if e != nil || !st.Mode().IsRegular() || st.Size() != s.Size {
			if _, e = a.db.Exec("UPDATE shares SET state='missing',error='文件丢失或大小不一致' WHERE id=?", s.ID); e != nil {
				return e
			}
		}
	}
	a.Cleanup()
	return nil
}
func (a *App) remove(name string) error {
	e := a.root.Remove(name)
	if errors.Is(e, os.ErrNotExist) {
		return nil
	}
	return e
}
func (a *App) Cleanup() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if e := a.diskReady(); e != nil {
		a.log.Warn("cleanup skipped: storage unavailable", "error", e)
		return
	}
	now := a.now().Unix()
	rows, e := a.db.Query("SELECT " + shareColumns + " FROM shares WHERE state!='deleted'")
	if e != nil {
		a.log.Error("cleanup query failed", "error", e)
		return
	}
	var shares []Share
	for rows.Next() {
		s, e := scanShare(rows)
		if e != nil {
			rows.Close()
			a.log.Error("cleanup scan failed", "error", e)
			return
		}
		shares = append(shares, s)
	}
	rows.Close()
	for _, s := range shares {
		if len(a.streams[s.ID]) > 0 {
			continue
		}
		eligible := s.State != "active" || now >= s.Expires
		if !eligible && s.DownloadCount >= s.MaxDownloads {
			var n int
			e = a.db.QueryRow("SELECT count(*) FROM download_sessions WHERE share_id=? AND version=? AND state='active' AND expires>? AND last_activity>?", s.ID, s.Version, now, now-int64(a.C.DownloadIdle.Seconds())).Scan(&n)
			if e != nil {
				continue
			}
			eligible = n == 0
		}
		if !eligible {
			continue
		}
		var retryAt int64
		if e = a.db.QueryRow("SELECT retry_at FROM shares WHERE id=?", s.ID).Scan(&retryAt); e != nil || now < retryAt {
			continue
		}
		if _, e = a.db.Exec("UPDATE shares SET state='deleting' WHERE id=?", s.ID); e != nil {
			continue
		}
		e = a.remove("files/" + s.StorageKey)
		if e == nil {
			e = a.syncDir("files")
		}
		if e != nil {
			var attempts int
			a.db.QueryRow("SELECT delete_attempts FROM shares WHERE id=?", s.ID).Scan(&attempts)
			backoff := min(3600, 60*(1<<min(attempts, 6)))
			_, _ = a.db.Exec("UPDATE shares SET error='文件删除失败，等待重试',delete_attempts=delete_attempts+1,retry_at=? WHERE id=?", now+int64(backoff), s.ID)
			a.log.Error("delete failed", "share_id", s.ID, "error", e)
			continue
		}
		if _, e = a.db.Exec("UPDATE shares SET state='deleted',deleted_at=?,error='',retry_at=0 WHERE id=?", now, s.ID); e != nil {
			a.log.Error("delete bookkeeping failed", "error", e)
			continue
		}
		a.audit("share_deleted", s.ID, "ok")
	}
	rows, e = a.db.Query("SELECT " + uploadColumns + " FROM uploads WHERE state NOT IN ('completed','cleaned')")
	if e != nil {
		return
	}
	var uploads []Upload
	for rows.Next() {
		u, e := scanUpload(rows)
		if e == nil {
			uploads = append(uploads, u)
		}
	}
	rows.Close()
	for _, u := range uploads {
		if a.busyUploads[u.ID] > 0 {
			continue
		}
		eligible := u.State == "canceled" || u.State == "failed" || u.State == "expired" || now-u.Updated >= int64(a.C.UploadTTL.Seconds())
		if !eligible {
			continue
		}
		if _, e = a.db.Exec("UPDATE uploads SET state='expired' WHERE id=? AND state IN ('created','uploading','finalizing')", u.ID); e != nil {
			continue
		}
		e = a.remove("tmp/" + u.ID + ".part")
		if e == nil {
			e = a.remove("files/" + u.StorageKey)
		}
		if e == nil {
			e = a.syncDir("tmp")
		}
		if e == nil {
			e = a.syncDir("files")
		}
		if e != nil {
			_, _ = a.db.Exec("UPDATE uploads SET error='残留文件删除失败，等待重试',attempts=attempts+1 WHERE id=?", u.ID)
			continue
		}
		_, _ = a.db.Exec("UPDATE uploads SET state='cleaned',updated=? WHERE id=?", now, u.ID)
	}
	// Delete sessions only after their active streams have stopped.
	_, _ = a.db.Exec("DELETE FROM admin_sessions WHERE expires<=?", now)
	_, _ = a.db.Exec("DELETE FROM share_grants WHERE expires<=?", now)
	for _, s := range shares {
		if len(a.streams[s.ID]) == 0 {
			_, _ = a.db.Exec("DELETE FROM download_sessions WHERE share_id=? AND (expires<=? OR state='revoked' OR (state='active' AND last_activity<=?))", s.ID, now, now-int64(a.C.DownloadIdle.Seconds()))
		}
	}
	tx, e := a.db.Begin()
	if e == nil {
		_, e = tx.Exec("DELETE FROM shares WHERE state='deleted' AND deleted_at<?", now-7*24*3600)
		if e == nil {
			_, e = tx.Exec("DELETE FROM uploads WHERE updated<? AND (state='cleaned' OR (state='completed' AND NOT EXISTS(SELECT 1 FROM shares WHERE upload_id=uploads.id)))", now-7*24*3600)
		}
		if e == nil {
			_, e = tx.Exec("DELETE FROM audit_events WHERE created<? OR id<(SELECT COALESCE(max(id),0)-10000 FROM audit_events)", now-7*24*3600)
		}
		if e == nil {
			e = tx.Commit()
		} else {
			tx.Rollback()
		}
		if e != nil {
			a.log.Error("retention cleanup failed", "error", e)
		}
	}
	for k, v := range a.limits {
		if !a.now().Before(v.until) {
			delete(a.limits, k)
		}
	}
	a.cleanOrphans()
	_, _ = a.db.Exec("PRAGMA wal_checkpoint(PASSIVE)")
}
func (a *App) cleanOrphans() {
	known := map[string]bool{}
	rows, e := a.db.Query("SELECT id,storage_key,state FROM uploads")
	if e != nil {
		return
	}
	for rows.Next() {
		var id, key, state string
		if rows.Scan(&id, &key, &state) == nil && state != "cleaned" {
			known["tmp/"+id+".part"] = state != "completed"
			known["files/"+key] = true
		}
	}
	rows.Close()
	for _, dir := range []string{"tmp", "files"} {
		entries, e := fs.ReadDir(a.root.FS(), dir)
		if e != nil {
			continue
		}
		for _, entry := range entries {
			p := dir + "/" + entry.Name()
			if known[p] {
				continue
			}
			st, e := entry.Info()
			if e != nil || a.now().Sub(st.ModTime()) < time.Hour {
				continue
			}
			if entry.IsDir() {
				continue
			}
			if e = a.remove(p); e != nil {
				a.log.Warn("orphan removal failed", "error", e)
			}
		}
	}
}
