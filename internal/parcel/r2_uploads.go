package parcel

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"

	"github.com/hyphy-void/Parcel/internal/r2"
)

var errR2Mismatch = errors.New("R2 对象或分块不符合上传任务")

func partCount(u Upload) int32 { return int32(max(1, (u.Size+u.PartBytes-1)/u.PartBytes)) }
func partSize(u Upload, number int32) int64 {
	return min(u.PartBytes, u.Size-int64(number-1)*u.PartBytes)
}

// Called with the upload lock held. R2, rather than the browser, is authoritative.
func (a *App) refreshR2(ctx context.Context, u *Upload) error {
	if a.r2 == nil {
		return fmt.Errorf("R2 未配置")
	}
	if isSinglePut(*u) {
		return a.refreshPut(ctx, u)
	}
	if u.MultipartID == "" {
		id, err := a.r2.Create(ctx, u.StorageKey, u.ID)
		if err != nil {
			return err
		}
		a.mu.Lock()
		_, err = a.db.Exec("UPDATE uploads SET multipart_id=? WHERE id=?", id, u.ID)
		a.mu.Unlock()
		if err != nil {
			_ = a.r2.Abort(ctx, u.StorageKey, id)
			return err
		}
		u.MultipartID = id
	}
	parts, err := a.r2.Parts(ctx, u.StorageKey, u.MultipartID)
	if err != nil {
		return err
	}
	u.Parts = parts
	u.Offset = 0
	// Only count an uninterrupted prefix with the expected sizes. Wrong or stray
	// parts must be replaced before completion, never accepted as progress.
	for i, p := range parts {
		if p.Number != int32(i+1) || p.Size != partSize(*u, p.Number) || p.ETag == "" {
			break
		}
		u.Offset += p.Size
	}
	a.mu.Lock()
	_, err = a.db.Exec("UPDATE uploads SET offset=?,state='uploading',updated=? WHERE id=? AND state IN ('created','uploading')", u.Offset, a.now().Unix(), u.ID)
	a.mu.Unlock()
	return err
}
func (a *App) signUploadPart(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	release := a.getUploadLock(id)
	defer release()
	u, err := a.upload(id)
	if err != nil {
		a.problem(w, r, 404, "not_found", "上传不存在")
		return
	}
	if u.Backend != "r2" || isSinglePut(u) || (u.State != "created" && u.State != "uploading") {
		a.problem(w, r, 409, "upload_not_writable", "上传状态不可写入")
		return
	}
	n, err := strconv.ParseInt(r.PathValue("part"), 10, 32)
	if err != nil || n < 1 || n > int64(partCount(u)) {
		a.problem(w, r, 400, "invalid_part", "分块编号不合法")
		return
	}
	if err = a.refreshR2(r.Context(), &u); err != nil {
		a.internal(w, r, err)
		return
	}
	address, err := a.r2.SignPart(r.Context(), u.StorageKey, u.MultipartID, int32(n), partSize(u, int32(n)))
	if err != nil {
		a.internal(w, r, err)
		return
	}
	jsonOK(w, 200, map[string]any{"url": address, "expires": a.now().Add(r2.URLTTL).Unix(), "size": partSize(u, int32(n))})
}
func (a *App) completeR2(w http.ResponseWriter, r *http.Request, u Upload) {
	// No client ETags or claims of success are accepted.
	if u.State != "finalizing" {
		if err := a.refreshR2(r.Context(), &u); err != nil {
			a.internal(w, r, err)
			return
		}
		if (isSinglePut(u) && !u.ObjectUploaded) || (!isSinglePut(u) && !validParts(u)) {
			a.problem(w, r, 409, "upload_incomplete", "R2 分块尚未完整或大小不匹配")
			return
		}
		a.mu.Lock()
		_, err := a.db.Exec("UPDATE uploads SET state='finalizing',updated=? WHERE id=?", a.now().Unix(), u.ID)
		a.mu.Unlock()
		if err != nil {
			a.internal(w, r, err)
			return
		}
	}
	a.startFinalize(u.ID)
	u.State = "finalizing"
	jsonOK(w, 202, u)
}
func validParts(u Upload) bool {
	if len(u.Parts) != int(partCount(u)) {
		return false
	}
	for i, p := range u.Parts {
		if p.Number != int32(i+1) || p.Size != partSize(u, p.Number) || p.ETag == "" {
			return false
		}
	}
	return true
}
func (a *App) finalizeR2(ctx context.Context, u Upload) error {
	if a.r2 == nil {
		return fmt.Errorf("R2 未配置")
	}
	// A completion may have succeeded before the process/connection was lost.
	// HEAD + immutable metadata lets a restart finish SQLite publication safely.
	var object r2.Object
	var err error
	if isSinglePut(u) {
		object, err = a.finalizePut(ctx, u)
	} else {
		object, err = a.r2.Head(ctx, u.StorageKey)
	}
	if !isSinglePut(u) && errors.Is(err, r2.ErrNotFound) {
		parts, e := a.r2.Parts(ctx, u.StorageKey, u.MultipartID)
		if e != nil {
			return e
		}
		u.Parts = parts
		if !validParts(u) {
			return errR2Mismatch
		}
		if e = a.r2.Complete(ctx, u.StorageKey, u.MultipartID, parts); e != nil { // Retryable completion uncertainty: inspect the object before giving up.
			object, err = a.r2.Head(ctx, u.StorageKey)
			if err != nil {
				return e
			}
		} else {
			object, err = a.r2.Head(ctx, u.StorageKey)
		}
	}
	if err != nil {
		return err
	}
	if object.Size != u.Size || object.UploadID != u.ID || object.ETag == "" {
		return errR2Mismatch
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	fresh, err := a.upload(u.ID)
	if err != nil {
		return err
	}
	if fresh.State != "finalizing" {
		return nil
	}
	tx, err := a.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := a.now().Unix()
	_, err = tx.Exec("INSERT INTO shares(id,upload_id,storage_key,name,size,sha256,password_hash,created,expires,max_downloads,backend,etag) VALUES(?,?,?,?,?,'',?,?,?,?, 'r2',?)", u.ShareID, u.ID, u.StorageKey, u.Name, u.Size, u.PasswordHash, now, now+u.TTL, u.MaxDownloads, object.ETag)
	if err != nil {
		return err
	}
	if _, err = tx.Exec("UPDATE uploads SET state='completed',offset=size,updated=?,error='' WHERE id=?", now, u.ID); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	a.audit("share_published", u.ShareID, "ok")
	return nil
}
