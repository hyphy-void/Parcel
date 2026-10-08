package parcel

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/hyphy-void/Parcel/internal/r2"
)

const uploadConfirmationBytes int64 = 100_000_000 // 100 decimal MB, not MiB.

func (a *App) usage() (used, reserved, pending int64, e error) {
	e = a.db.QueryRow("SELECT COALESCE(sum(size),0),COALESCE(sum(CASE WHEN state='deleting' THEN size ELSE 0 END),0) FROM shares WHERE state!='deleted'").Scan(&used, &pending)
	if e != nil {
		return
	}
	e = a.db.QueryRow("SELECT COALESCE(sum(size),0) FROM uploads WHERE state NOT IN ('completed','cleaned')").Scan(&reserved)
	return
}

// Budget includes incomplete files and the second copy of single-PUT uploads.
// It is Parcel's storage guard, not Cloudflare's account-wide monthly bill.
func (a *App) r2Usage() (used, reserved int64, err error) {
	err = a.db.QueryRow("SELECT COALESCE(sum(size),0) FROM shares WHERE backend='r2' AND state!='deleted'").Scan(&used)
	if err != nil {
		return
	}
	err = a.db.QueryRow("SELECT COALESCE(sum(CASE WHEN state='completed' THEN size WHEN part_bytes=0 THEN size*2 ELSE size END),0) FROM uploads WHERE backend='r2' AND ((state NOT IN ('completed','cleaned')) OR (state='completed' AND part_bytes=0 AND staging_cleaned=0))").Scan(&reserved)
	return
}
func (a *App) status(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	used, reserved, pending, e := a.usage()
	r2Used, r2Reserved, r2Err := a.r2Usage()
	if e == nil {
		e = r2Err
	}
	activeDownloads := 0
	for _, v := range a.streams {
		activeDownloads += len(v)
	}
	activeUploads := len(a.uploadSlots)
	activeFinalizations := len(a.finalizeSlots)
	a.mu.Unlock()
	if e != nil {
		a.internal(w, r, e)
		return
	}
	free, e := a.freeBytes()
	if e != nil {
		a.internal(w, r, e)
		return
	}
	jsonOK(w, 200, map[string]any{"r2_used_bytes": r2Used, "r2_reserved_bytes": r2Reserved, "r2_quota_bytes": a.C.R2Quota, "r2_available_bytes": max(0, a.C.R2Quota-r2Used-r2Reserved), "storage_backend": a.C.StorageBackend, "upload_confirmation_bytes": uploadConfirmationBytes, "used_bytes": used, "reserved_bytes": reserved, "pending_bytes": pending, "free_bytes": free, "quota_bytes": a.C.Quota, "min_free_bytes": a.C.MinFree, "max_file_bytes": a.C.MaxFile, "chunk_bytes": a.C.Chunk, "default_ttl_seconds": int64(a.C.ShareTTL.Seconds()), "max_ttl_seconds": int64(a.C.MaxShareTTL.Seconds()), "default_download_limit": a.C.DownloadLimit, "version": Version, "base_url": a.C.BaseURL, "active_downloads": activeDownloads, "active_uploads": activeUploads, "active_finalizations": activeFinalizations})
}
func (a *App) createUpload(w http.ResponseWriter, r *http.Request) {
	if !a.rate(w, r, "upload:"+a.clientIP(r), 30, time.Minute) {
		return
	}
	var req struct {
		Name         string `json:"name"`
		Size         int64  `json:"size"`
		TTL          int64  `json:"ttl_seconds"`
		MaxDownloads int    `json:"max_downloads"`
		Password     string `json:"password"`
		ConfirmLarge bool   `json:"confirm_large"`
	}
	if !a.decode(w, r, &req) {
		return
	}
	if req.Name == "" || len(req.Name) > 1024 || strings.ContainsAny(req.Name, "/\\") || strings.IndexFunc(req.Name, unicode.IsControl) >= 0 {
		a.problem(w, r, 400, "invalid_filename", "文件名不合法")
		return
	}
	if req.Size < 0 || req.Size > a.C.MaxFile {
		a.problem(w, r, 413, "file_too_large", "文件超过大小限制")
		return
	}
	if req.Size > uploadConfirmationBytes && !req.ConfirmLarge {
		a.problem(w, r, 400, "confirmation_required", "超过 100 MB（100,000,000 字节）需要确认后上传")
		return
	}
	if req.TTL == 0 {
		req.TTL = int64(a.C.ShareTTL.Seconds())
	}
	if req.TTL < 1 || req.TTL > int64(a.C.MaxShareTTL.Seconds()) {
		a.problem(w, r, 400, "invalid_ttl", "分享有效期不合法")
		return
	}
	if req.MaxDownloads == 0 {
		req.MaxDownloads = a.C.DownloadLimit
	}
	if req.MaxDownloads < 1 || req.MaxDownloads > 100 {
		a.problem(w, r, 400, "invalid_limit", "下载次数应为 1–100")
		return
	}
	idem := r.Header.Get("Idempotency-Key")
	if len(idem) > 128 {
		a.problem(w, r, 400, "invalid_idempotency_key", "幂等键过长")
		return
	}
	var hash string
	if req.Password != "" {
		select {
		case a.hashSlots <- struct{}{}:
		default:
			a.problem(w, r, 503, "busy", "密码处理繁忙")
			return
		}
		var e error
		hash, e = hashSharePassword(req.Password)
		<-a.hashSlots
		if e != nil {
			a.problem(w, r, 400, "invalid_password", e.Error())
			return
		}
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if idem != "" {
		u, e := scanUpload(a.db.QueryRow("SELECT "+uploadColumns+" FROM uploads WHERE idem=?", tokenHash(idem)))
		if e == nil {
			if u.Name != req.Name || u.Size != req.Size || u.TTL != req.TTL || u.MaxDownloads != req.MaxDownloads || (u.PasswordHash == "") != (req.Password == "") || (u.PasswordHash != "" && !checkPassword(req.Password, u.PasswordHash)) {
				a.problem(w, r, 409, "idempotency_conflict", "幂等键已用于其他上传")
				return
			}
			jsonOK(w, 200, u)
			return
		}
		if !missing(e) {
			a.internal(w, r, e)
			return
		}
	}
	if e := a.diskReady(); e != nil {
		a.problem(w, r, 503, "storage_unavailable", "存储挂载不可用")
		return
	}
	used, reserved, _, e := a.usage()
	if e != nil {
		a.internal(w, r, e)
		return
	}
	if a.r2 != nil {
		r2Used, r2Reserved, err := a.r2Usage()
		if err != nil {
			a.internal(w, r, err)
			return
		}
		needed := req.Size
		if req.Size <= uploadConfirmationBytes {
			needed *= 2
		}
		if needed > a.C.R2Quota-r2Used-r2Reserved {
			a.problem(w, r, 507, "r2_quota_exceeded", "R2 存储保护额度不足，已停止新上传。请等待文件清理释放空间。")
			return
		}
	}
	free, e := a.freeBytes()
	if e != nil {
		a.internal(w, r, e)
		return
	}
	var remaining int64
	if e = a.db.QueryRow("SELECT COALESCE(sum(size-offset),0) FROM uploads WHERE backend='local' AND state IN ('created','uploading','finalizing')").Scan(&remaining); e != nil {
		a.internal(w, r, e)
		return
	}
	if req.Size > a.C.Quota-used-reserved || (a.r2 == nil && free-a.C.MinFree-remaining < req.Size) || (a.r2 != nil && free < a.C.MinFree) {
		a.problem(w, r, 507, "insufficient_storage", "存储空间或配额不足")
		return
	}
	var n int
	a.db.QueryRow("SELECT count(*) FROM uploads WHERE state NOT IN ('completed','cleaned')").Scan(&n)
	if n >= 100 {
		a.problem(w, r, 429, "too_many_uploads", "未完成上传过多，请先取消或等待清理")
		return
	}
	id, key, shareID := randomToken(), randomToken(), randomToken()
	if a.r2 == nil {
		f, e := a.root.OpenFile("tmp/"+id+".part", os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if e != nil {
			a.internal(w, r, e)
			return
		}
		e = f.Sync()
		f.Close()
		if e == nil {
			e = a.syncDir("tmp")
		}
		if e != nil {
			a.root.Remove("tmp/" + id + ".part")
			a.internal(w, r, e)
			return
		}
	}
	var idemValue any
	if idem != "" {
		idemValue = tokenHash(idem)
	}
	backend, partBytes := "local", int64(0)
	if a.r2 != nil {
		backend = "r2"
		if req.Size > uploadConfirmationBytes {
			partBytes = r2.PartSize
		}
		key = "parcel/v2/" + key
	}
	_, e = a.db.Exec("INSERT INTO uploads(id,name,size,ttl,max_downloads,password_hash,state,storage_key,share_id,created,updated,idem,backend,part_bytes) VALUES(?,?,?,?,?,?,'created',?,?,?,?,?,?,?)", id, req.Name, req.Size, req.TTL, req.MaxDownloads, hash, key, shareID, a.now().Unix(), a.now().Unix(), idemValue, backend, partBytes)
	if e != nil {
		a.root.Remove("tmp/" + id + ".part")
		a.internal(w, r, e)
		return
	}
	a.audit("upload_created", id, "ok")
	u, e := a.upload(id)
	if e != nil {
		a.internal(w, r, e)
		return
	}
	jsonOK(w, 201, u)
}
func (a *App) getUpload(w http.ResponseWriter, r *http.Request) {
	release := a.getUploadLock(r.PathValue("id"))
	defer release()
	u, e := a.upload(r.PathValue("id"))
	if e != nil {
		if missing(e) {
			a.problem(w, r, 404, "not_found", "上传不存在")
		} else {
			a.internal(w, r, e)
		}
		return
	}
	if u.Backend == "r2" && (u.State == "created" || u.State == "uploading") {
		if e = a.refreshR2(r.Context(), &u); e != nil {
			a.internal(w, r, e)
			return
		}
	}
	if u.Backend == "r2" && u.State == "finalizing" && a.now().Unix()-u.Updated >= 30 {
		a.startFinalize(u.ID)
	}
	jsonOK(w, 200, u)
}
func (a *App) lookupUpload(w http.ResponseWriter, r *http.Request) {
	key := r.Header.Get("Idempotency-Key")
	if key == "" || len(key) > 128 {
		a.problem(w, r, 400, "invalid_idempotency_key", "缺少有效的幂等键")
		return
	}
	u, e := scanUpload(a.db.QueryRow("SELECT "+uploadColumns+" FROM uploads WHERE idem=?", tokenHash(key)))
	if e != nil {
		if missing(e) {
			a.problem(w, r, 404, "not_found", "尚未创建上传")
		} else {
			a.internal(w, r, e)
		}
		return
	}
	jsonOK(w, 200, u)
}
func (a *App) patchUpload(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !isSafeID(id) {
		a.problem(w, r, 404, "not_found", "上传不存在")
		return
	}
	select {
	case a.uploadSlots <- struct{}{}:
		defer func() { <-a.uploadSlots }()
	default:
		w.Header().Set("Retry-After", "2")
		a.problem(w, r, 503, "upload_busy", "上传繁忙，请重试")
		return
	}
	release := a.getUploadLock(id)
	defer release()
	offset, e := strconv.ParseInt(r.Header.Get("Upload-Offset"), 10, 64)
	if e != nil || offset < 0 {
		a.problem(w, r, 400, "invalid_offset", "缺少有效的 Upload-Offset")
		return
	}
	a.mu.Lock()
	u, e := a.upload(id)
	if e != nil {
		a.mu.Unlock()
		a.problem(w, r, 404, "not_found", "上传不存在")
		return
	}
	if u.Backend == "r2" {
		a.mu.Unlock()
		a.problem(w, r, 409, "direct_upload_required", "请使用 R2 直传分块地址")
		return
	}
	if u.State != "created" && u.State != "uploading" {
		a.mu.Unlock()
		a.problem(w, r, 409, "upload_not_writable", "上传状态不可写入")
		return
	}
	if offset != u.Offset {
		a.mu.Unlock()
		w.Header().Set("Upload-Offset", strconv.FormatInt(u.Offset, 10))
		a.problem(w, r, 409, "offset_conflict", "上传偏移冲突，请查询后续传")
		return
	}
	if e = a.diskReady(); e != nil {
		a.mu.Unlock()
		a.problem(w, r, 503, "storage_unavailable", "存储挂载不可用")
		return
	}
	free, e := a.freeBytes()
	if e != nil || free < a.C.MinFree {
		a.mu.Unlock()
		a.problem(w, r, 507, "insufficient_storage", "磁盘可用空间不足")
		return
	}
	a.busyUploads[id]++
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		a.busyUploads[id]--
		if a.busyUploads[id] == 0 {
			delete(a.busyUploads, id)
		}
		a.mu.Unlock()
	}()
	capBytes := min(a.C.Chunk, u.Size-u.Offset)
	if capBytes <= 0 {
		a.problem(w, r, 409, "upload_complete", "全部字节已上传，请完成上传")
		return
	}
	if r.ContentLength > capBytes {
		a.problem(w, r, 413, "chunk_too_large", "分块超过限制")
		return
	}
	ctl := http.NewResponseController(w)
	_ = ctl.SetReadDeadline(time.Now().Add(2 * time.Minute))
	defer ctl.SetReadDeadline(time.Time{})
	f, e := a.root.OpenFile("tmp/"+id+".part", os.O_RDWR, 0600)
	if e != nil {
		a.internal(w, r, e)
		return
	}
	defer f.Close()
	if _, e = f.Seek(u.Offset, io.SeekStart); e != nil {
		a.internal(w, r, e)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, capBytes)
	n, e := io.CopyBuffer(f, r.Body, make([]byte, 128<<10))
	if e == nil && n == 0 {
		e = fmt.Errorf("空分块")
	}
	if e == nil {
		e = f.Sync()
	}
	if e != nil {
		// Drain the already bounded chunk so an early disk error does not reset
		// the connection while the client is still sending and hide our 507.
		_, _ = io.Copy(io.Discard, r.Body)
		f.Truncate(u.Offset)
		f.Sync()
		var big *http.MaxBytesError
		if errors.As(e, &big) {
			a.problem(w, r, 413, "chunk_too_large", "分块超过限制")
		} else if errors.Is(e, os.ErrPermission) {
			a.problem(w, r, 503, "storage_unavailable", "无法写入文件")
		} else {
			a.problem(w, r, 507, "chunk_failed", "分块未确认，请查询偏移后重试")
		}
		return
	}
	a.mu.Lock()
	result, e := a.db.Exec("UPDATE uploads SET offset=?,state='uploading',updated=? WHERE id=? AND offset=? AND state IN ('created','uploading')", u.Offset+n, a.now().Unix(), id, u.Offset)
	var changed int64
	if e == nil {
		changed, _ = result.RowsAffected()
	}
	a.mu.Unlock()
	if e != nil || changed != 1 {
		f.Truncate(u.Offset)
		f.Sync()
		if e != nil {
			a.internal(w, r, e)
		} else {
			a.problem(w, r, 409, "upload_not_writable", "上传已取消")
		}
		return
	}
	w.Header().Set("Upload-Offset", strconv.FormatInt(u.Offset+n, 10))
	jsonOK(w, 200, map[string]any{"offset": u.Offset + n})
}
func (a *App) completeUpload(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	release := a.getUploadLock(id)
	defer release()
	a.mu.Lock()
	u, e := a.upload(id)
	if e != nil {
		a.mu.Unlock()
		a.problem(w, r, 404, "not_found", "上传不存在")
		return
	}
	if u.State == "completed" {
		a.mu.Unlock()
		jsonOK(w, 200, u)
		return
	}
	if u.State != "finalizing" && u.State != "created" && u.State != "uploading" {
		a.mu.Unlock()
		a.problem(w, r, 409, "upload_not_writable", "上传已失效")
		return
	}
	if u.Backend == "r2" {
		a.mu.Unlock()
		a.completeR2(w, r, u)
		return
	}
	if u.Offset != u.Size {
		a.mu.Unlock()
		a.problem(w, r, 409, "upload_incomplete", "文件尚未全部上传")
		return
	}
	_, e = a.db.Exec("UPDATE uploads SET state='finalizing',updated=? WHERE id=?", a.now().Unix(), id)
	a.mu.Unlock()
	if e != nil {
		a.internal(w, r, e)
		return
	}
	a.startFinalize(id)
	u.State = "finalizing"
	jsonOK(w, 202, u)
}
func (a *App) cancelUpload(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	// Local hashing is interruptible and must not delay cancellation. R2 control
	// operations need serialization to prevent a completion/cancel race.
	initial, _ := a.upload(id)
	if initial.Backend == "r2" {
		release := a.getUploadLock(id)
		defer release()
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	u, e := a.upload(id)
	if e != nil {
		a.problem(w, r, 404, "not_found", "上传不存在")
		return
	}
	if u.State == "completed" {
		a.problem(w, r, 409, "already_published", "文件已发布，请撤销分享")
		return
	}
	if _, e = a.db.Exec("UPDATE uploads SET state='canceled',updated=? WHERE id=? AND state!='cleaned'", a.now().Unix(), id); e != nil {
		a.internal(w, r, e)
		return
	}
	if cancel := a.uploadCancel[id]; cancel != nil {
		cancel()
	}
	a.audit("upload_canceled", id, "ok")
	jsonOK(w, 200, map[string]bool{"ok": true})
}

func (a *App) startFinalize(id string) {
	a.mu.Lock()
	if a.finalizing[id] || a.ctx.Err() != nil {
		a.mu.Unlock()
		return
	}
	a.finalizing[id] = true
	a.busyUploads[id]++
	ctx, cancel := context.WithCancel(a.ctx)
	a.uploadCancel[id] = cancel
	a.wg.Add(1)
	a.mu.Unlock()
	go func() {
		defer a.wg.Done()
		defer cancel()
		defer func() {
			a.mu.Lock()
			delete(a.finalizing, id)
			delete(a.uploadCancel, id)
			a.busyUploads[id]--
			if a.busyUploads[id] == 0 {
				delete(a.busyUploads, id)
			}
			a.mu.Unlock()
		}()
		select {
		case a.finalizeSlots <- struct{}{}:
			defer func() { <-a.finalizeSlots }()
		case <-ctx.Done():
			return
		}
		release := a.getUploadLock(id)
		defer release()
		if e := a.finalize(ctx, id); e != nil {
			if ctx.Err() != nil {
				return
			}
			a.log.Error("finalization failed", "upload_id", id, "error", e)
			a.mu.Lock()
			retryable := !errors.Is(e, errR2Mismatch) && !errors.Is(e, r2.ErrNotFound)
			_, _ = a.db.Exec("UPDATE uploads SET state=CASE WHEN backend='r2' AND ? THEN 'finalizing' ELSE 'failed' END,error='文件校验或发布失败',updated=? WHERE id=? AND state='finalizing'", retryable, a.now().Unix(), id)
			a.mu.Unlock()
		}
	}()
}
func (a *App) finalize(ctx context.Context, id string) error {
	a.mu.Lock()
	u, e := a.upload(id)
	a.mu.Unlock()
	if e != nil {
		return e
	}
	if u.State != "finalizing" {
		return nil
	}
	if u.Backend == "r2" {
		return a.finalizeR2(ctx, u)
	}
	if e = a.diskReady(); e != nil {
		return e
	}
	tmp := "tmp/" + id + ".part"
	final := "files/" + u.StorageKey
	source := tmp
	f, e := a.root.Open(source)
	if errors.Is(e, os.ErrNotExist) {
		source = final
		f, e = a.root.Open(source)
	}
	if e != nil {
		return e
	}
	defer f.Close()
	st, e := f.Stat()
	if e != nil {
		return e
	}
	if st.Size() != u.Size {
		return fmt.Errorf("文件大小不匹配")
	}
	h := sha256.New()
	buf := make([]byte, 256<<10)
	last := time.Now()
	for {
		if e = ctx.Err(); e != nil {
			return e
		}
		n, readErr := f.Read(buf)
		if n > 0 {
			h.Write(buf[:n])
		}
		if time.Since(last) > 5*time.Second {
			a.mu.Lock()
			_, _ = a.db.Exec("UPDATE uploads SET updated=? WHERE id=? AND state='finalizing'", a.now().Unix(), id)
			a.mu.Unlock()
			last = time.Now()
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return readErr
		}
	}
	sum := hex.EncodeToString(h.Sum(nil))
	if e = ctx.Err(); e != nil {
		return e
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	fresh, e := a.upload(id)
	if e != nil {
		return e
	}
	if fresh.State != "finalizing" {
		return nil
	}
	if source == tmp {
		if e = a.root.Rename(tmp, final); e != nil {
			return e
		}
		if e = a.syncDir("files"); e != nil {
			return e
		}
		if e = a.syncDir("tmp"); e != nil {
			return e
		}
	}
	tx, e := a.db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	now := a.now().Unix()
	if _, e = tx.Exec("INSERT INTO shares(id,upload_id,storage_key,name,size,sha256,password_hash,created,expires,max_downloads) VALUES(?,?,?,?,?,?,?,?,?,?)", u.ShareID, id, u.StorageKey, u.Name, u.Size, sum, u.PasswordHash, now, now+u.TTL, u.MaxDownloads); e != nil {
		return e
	}
	if _, e = tx.Exec("UPDATE uploads SET state='completed',updated=?,error='' WHERE id=?", now, id); e != nil {
		return e
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	a.audit("share_published", u.ShareID, "ok")
	return nil
}
func (a *App) syncDir(name string) error {
	f, e := a.root.Open(name)
	if e != nil {
		return e
	}
	defer f.Close()
	return f.Sync()
}
