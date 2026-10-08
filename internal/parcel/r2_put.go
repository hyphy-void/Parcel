package parcel

import (
	"context"
	"errors"
	"net/http"

	"github.com/hyphy-void/Parcel/internal/r2"
)

func putStagingKey(u Upload) string { return u.StorageKey + ".pending" }
func isSinglePut(u Upload) bool     { return u.Backend == "r2" && u.PartBytes == 0 }
func matchesUpload(o r2.Object, u Upload) bool {
	return o.Size == u.Size && o.UploadID == u.ID && o.ETag != ""
}

// Whole PUT is atomic in R2: interrupted bytes are never admitted as progress.
func (a *App) refreshPut(ctx context.Context, u *Upload) error {
	o, err := a.r2.Head(ctx, putStagingKey(*u))
	if errors.Is(err, r2.ErrNotFound) {
		u.Offset = 0
		u.ObjectUploaded = false
	} else if err != nil {
		return err
	} else {
		u.ObjectUploaded = matchesUpload(o, *u)
		if u.ObjectUploaded {
			u.Offset = u.Size
		} else {
			u.Offset = 0
		}
	}
	a.mu.Lock()
	_, err = a.db.Exec("UPDATE uploads SET offset=? WHERE id=? AND state IN ('created','uploading')", u.Offset, u.ID)
	a.mu.Unlock()
	return err
}
func (a *App) signUploadObject(w http.ResponseWriter, r *http.Request) {
	release := a.getUploadLock(r.PathValue("id"))
	defer release()
	u, err := a.upload(r.PathValue("id"))
	if err != nil {
		a.problem(w, r, 404, "not_found", "上传不存在")
		return
	}
	if !isSinglePut(u) || (u.State != "created" && u.State != "uploading") {
		a.problem(w, r, 409, "upload_not_writable", "上传状态不可写入")
		return
	}
	address, headers, err := a.r2.SignPut(r.Context(), putStagingKey(u), u.ID, u.Size)
	if err != nil {
		a.internal(w, r, err)
		return
	}
	expires := a.now().Add(r2.URLTTL).Unix()
	a.mu.Lock()
	_, err = a.db.Exec("UPDATE uploads SET put_expires=max(put_expires,?),updated=? WHERE id=?", expires, a.now().Unix(), u.ID)
	a.mu.Unlock()
	if err != nil {
		a.internal(w, r, err)
		return
	}
	jsonOK(w, 200, map[string]any{"url": address, "headers": headers, "expires": expires, "size": u.Size})
}
func (a *App) finalizePut(ctx context.Context, u Upload) (r2.Object, error) {
	// A copy can have completed before SQLite committed; the final key is never
	// writable with a browser URL, so an already valid copy safely resumes.
	o, err := a.r2.Head(ctx, u.StorageKey)
	if errors.Is(err, r2.ErrNotFound) {
		source, e := a.r2.Head(ctx, putStagingKey(u))
		if e != nil {
			return r2.Object{}, e
		}
		if !matchesUpload(source, u) {
			return r2.Object{}, errR2Mismatch
		}
		if e = a.r2.Copy(ctx, putStagingKey(u), u.StorageKey, source.ETag); e != nil {
			return r2.Object{}, e
		}
		o, err = a.r2.Head(ctx, u.StorageKey)
	}
	if err != nil {
		return r2.Object{}, err
	}
	if !matchesUpload(o, u) {
		return r2.Object{}, errR2Mismatch
	}
	return o, nil
}
