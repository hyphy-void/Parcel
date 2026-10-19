package parcel

import (
	"context"
	"database/sql"
	"errors"
	"github.com/hyphy-void/Parcel/internal/config"
	"io"
	"log/slog"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/hyphy-void/Parcel/internal/r2"
)

type fakeR2 struct {
	mu                             sync.Mutex
	parts                          []r2.Part
	object                         r2.Object
	staging                        r2.Object
	copied, stagingDeleted         int
	completed, aborted, deleted    int
	failHead, failSign, failDelete bool
	metadata                       string
}

func (s *fakeR2) Create(_ context.Context, _ string, id string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.metadata = id
	return "multipart", nil
}
func (s *fakeR2) Parts(context.Context, string, string) ([]r2.Part, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]r2.Part{}, s.parts...), nil
}
func (s *fakeR2) SignPart(context.Context, string, string, int32, int64) (string, error) {
	return "https://test.r2.cloudflarestorage.com/part", nil
}
func (s *fakeR2) Complete(context.Context, string, string, []r2.Part) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.completed++
	s.object.UploadID = s.metadata
	for _, p := range s.parts {
		s.object.Size += p.Size
	}
	s.object.ETag = "opaque-2"
	return nil
}
func (s *fakeR2) Head(_ context.Context, key string) (r2.Object, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failHead {
		return r2.Object{}, errors.New("offline")
	}
	if strings.HasSuffix(key, ".pending") {
		if s.staging.ETag == "" {
			return r2.Object{}, r2.ErrNotFound
		}
		return s.staging, nil
	}
	if s.object.ETag == "" {
		return r2.Object{}, r2.ErrNotFound
	}
	return s.object, nil
}
func (s *fakeR2) Abort(context.Context, string, string) error { s.aborted++; return nil }
func (s *fakeR2) Delete(_ context.Context, key string) error {
	if s.failDelete {
		return errors.New("offline")
	}
	if strings.HasSuffix(key, ".pending") {
		s.stagingDeleted++
		s.staging = r2.Object{}
	} else {
		s.deleted++
		s.object = r2.Object{}
	}
	return nil
}
func (s *fakeR2) SignGet(context.Context, string, string) (string, error) {
	if s.failSign {
		return "", errors.New("offline")
	}
	return "https://test.r2.cloudflarestorage.com/file?X-Amz-Expires=300", nil
}
func (s *fakeR2) SignPut(_ context.Context, _ string, id string, _ int64) (string, map[string]string, error) {
	s.metadata = id
	return "https://test.r2.cloudflarestorage.com/object", map[string]string{}, nil
}
func (s *fakeR2) Copy(_ context.Context, _, _ string, etag string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.staging.ETag != etag {
		return errors.New("source changed")
	}
	s.object = s.staging
	s.copied++
	return nil
}

func useR2(f *fixture) *fakeR2 {
	s := &fakeR2{}
	f.a.r2 = s
	f.a.C.StorageBackend = "r2"
	f.a.C.R2Quota = 9_000_000_000
	f.a.C.R2Endpoint = "https://test.r2.cloudflarestorage.com"
	return s
}
func r2Publish(t *testing.T, f *fixture, s *fakeR2, limit int) Share {
	t.Helper()
	u := f.create(t, 7, "", limit)
	decodeResponse[Upload](t, f.request("GET", "/api/v1/uploads/"+u.ID, nil, nil, true), 200)
	s.parts = []r2.Part{{Number: 1, Size: 7, ETag: "part"}}
	decodeResponse[Upload](t, f.request("POST", "/api/v1/uploads/"+u.ID+"/complete", nil, nil, true), 202)
	for range 200 {
		v, _ := f.a.upload(u.ID)
		if v.State == "completed" {
			share, e := f.a.share(u.ShareID)
			if e != nil {
				t.Fatal(e)
			}
			return share
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("R2 publication timeout")
	return Share{}
}
func TestR2RecoveryAndValidation(t *testing.T) {
	f := testApp(t)
	s := useR2(f)
	u := f.create(t, 7, "", 2)
	if w := f.request("POST", "/api/v1/uploads/"+u.ID+"/parts/1", nil, nil, false); w.Code != 401 {
		t.Fatal("part signing without admin")
	}
	if w := f.request("GET", "/admin/new", nil, nil, false); !strings.Contains(w.Header().Get("Content-Security-Policy"), f.a.C.R2Endpoint) {
		t.Fatal("R2 missing from CSP")
	}
	if _, e := f.a.root.Stat("tmp/" + u.ID + ".part"); e == nil {
		t.Fatal("R2 wrote local payload")
	}
	if w := f.request("PATCH", "/api/v1/uploads/"+u.ID, []byte("payload"), map[string]string{"Upload-Offset": "0"}, true); w.Code != 409 {
		t.Fatal(w.Code)
	}
	if w := f.request("POST", "/api/v1/uploads/"+u.ID+"/parts/2", nil, nil, true); w.Code != 400 {
		t.Fatal(w.Code)
	}
	// A wrong size cannot be admitted or counted as recovered progress.
	s.parts = []r2.Part{{Number: 1, Size: 6, ETag: "p"}}
	v := decodeResponse[Upload](t, f.request("GET", "/api/v1/uploads/"+u.ID, nil, nil, true), 200)
	if v.Offset != 0 {
		t.Fatal(v.Offset)
	}
	if w := f.request("POST", "/api/v1/uploads/"+u.ID+"/complete", nil, nil, true); w.Code != 409 {
		t.Fatal(w.Code)
	}
	s.parts = []r2.Part{{Number: 1, Size: 7, ETag: "p"}}
	v = decodeResponse[Upload](t, f.request("GET", "/api/v1/uploads/"+u.ID, nil, nil, true), 200)
	if v.Offset != 7 {
		t.Fatal(v.Offset)
	}
	// Simulate R2 completed, but process died before committing SQLite.
	s.object = r2.Object{Size: 7, UploadID: u.ID, ETag: "multipart-etag"}
	_, _ = f.a.db.Exec("UPDATE uploads SET state='finalizing' WHERE id=?", u.ID)
	if e := f.a.recover(); e != nil {
		t.Fatal(e)
	}
	if e := f.a.finalize(context.Background(), u.ID); e != nil {
		t.Fatal(e)
	}
	share, _ := f.a.share(u.ShareID)
	if share.SHA256 != "" || share.ETag != "multipart-etag" || share.Backend != "r2" {
		t.Fatalf("unexpected integrity fields: %+v", share)
	}
	if s.completed != 0 {
		t.Fatal("completed multipart twice")
	}
	if w := f.request("POST", "/api/v1/uploads/"+u.ID+"/parts/1", nil, nil, true); w.Code != 409 {
		t.Fatal("signed after publication")
	}
}
func TestR2DownloadSessionsAndCleanup(t *testing.T) {
	f := testApp(t)
	s := useR2(f)
	share := r2Publish(t, f, s, 1)
	s.failSign = true
	if w := f.request("POST", "/api/v1/shares/"+share.ID+"/download-sessions", nil, nil, false); w.Code != 500 {
		t.Fatal(w.Code)
	}
	count(t, f.a, share.ID, 0)
	s.failSign = false
	ticket := decodeResponse[map[string]any](t, f.request("POST", "/api/v1/shares/"+share.ID+"/download-sessions", nil, nil, false), 201)
	if ticket["expires"].(float64)-float64(f.a.now().Unix()) != 300 {
		t.Fatal("URL TTL")
	}
	count(t, f.a, share.ID, 1)
	f.a.Cleanup()
	if s.deleted != 0 {
		t.Fatal("deleted active session")
	}
	renew := func(session string) *http.Response {
		return f.request("POST", "/api/v1/shares/"+share.ID+"/download-sessions/refresh", map[string]any{"session": session}, nil, false).Result()
	}
	if v := renew(ticket["session"].(string)); v.StatusCode != 200 {
		t.Fatal(v.StatusCode)
	}
	count(t, f.a, share.ID, 1)
	if v := renew(randomToken()); v.StatusCode != 401 {
		t.Fatal(v.StatusCode)
	}
	if w := f.request("POST", "/api/v1/shares/"+share.ID+"/download-sessions", nil, nil, false); w.Code != 410 {
		t.Fatal(w.Code)
	}
	f.request("DELETE", "/api/v1/admin/shares/"+share.ID, nil, nil, true)
	if v := renew(ticket["session"].(string)); v.StatusCode != 410 {
		t.Fatal("revocation allowed renewal")
	}
	f.a.Cleanup()
	if s.deleted != 0 {
		t.Fatal("revocation deleted an issued URL's object")
	}
	future := time.Now().Add(f.a.C.DownloadMax + time.Minute)
	f.a.now = func() time.Time { return future }
	s.failDelete = true
	f.a.Cleanup()
	_, reserved, _, e := f.a.usage()
	if e != nil || reserved != 0 {
		t.Fatal(e)
	}
	v, _ := f.a.share(share.ID)
	if v.State != "deleting" {
		t.Fatal(v.State)
	}
	s.failDelete = false
	future = future.Add(2 * time.Minute)
	f.a.Cleanup()
	if s.deleted != 1 {
		t.Fatal("cleanup retry failed")
	}
}
func TestR2QuotaCancelAndLocalCompatibility(t *testing.T) {
	f := testApp(t)
	local := f.publish(t, []byte("legacy"), "", 1)
	s := useR2(f)
	ticket := f.ticket(t, local.ID, nil)
	if w := f.request("GET", ticket, nil, nil, false); w.Code != 200 || w.Body.String() != "legacy" {
		t.Fatal("legacy download failed")
	}
	u := f.create(t, 7, "", 1)
	f.request("GET", "/api/v1/uploads/"+u.ID, nil, nil, true)
	used, reserved, _, _ := f.a.usage()
	if used != 6 || reserved != 7 {
		t.Fatalf("usage %d/%d", used, reserved)
	}
	f.a.C.Quota = 13
	if w := f.request("POST", "/api/v1/uploads", map[string]any{"name": "extra", "size": 1}, nil, true); w.Code != 507 {
		t.Fatal(w.Code)
	}
	f.request("DELETE", "/api/v1/uploads/"+u.ID, nil, nil, true)
	f.a.Cleanup()
	if s.aborted != 1 {
		t.Fatal("multipart not aborted")
	}
	_, reserved, _, _ = f.a.usage()
	if reserved != 0 {
		t.Fatal("reservation not released")
	}
}
func TestUploadConfirmationBoundary(t *testing.T) {
	f := testApp(t)
	useR2(f)
	f.a.C.MaxFile = 1 << 30
	f.a.C.Quota = 2 << 30
	for _, size := range []int64{100_000_000, 100_000_001} {
		w := f.request("POST", "/api/v1/uploads", map[string]any{"name": "big", "size": size}, nil, true)
		if size == 100_000_000 && w.Code != 201 {
			t.Fatal(w.Code)
		}
		if size > 100_000_000 && (w.Code != 400 || !strings.Contains(w.Body.String(), "confirmation_required")) {
			t.Fatal(w.Body.String())
		}
	}
	if w := f.request("POST", "/api/v1/uploads", map[string]any{"name": "big", "size": 100_000_001, "confirm_large": true}, nil, true); w.Code != 201 {
		t.Fatal(w.Code)
	}
}
func TestMultipartPlan(t *testing.T) {
	u := Upload{Size: r2.PartSize + 3, PartBytes: r2.PartSize, Parts: []r2.Part{{Number: 1, Size: r2.PartSize, ETag: "a"}, {Number: 2, Size: 3, ETag: "b"}}}
	if !validParts(u) {
		t.Fatal("valid rejected")
	}
	u.Parts[1].Number = 3
	if validParts(u) {
		t.Fatal("gap accepted")
	}
	u.Parts = []r2.Part{{Number: 1, Size: 0, ETag: "empty"}}
	u.Size = 0
	if !validParts(u) {
		t.Fatal("empty file rejected")
	}
}

func TestR2PasswordAndSessionBoundaries(t *testing.T) {
	f := testApp(t)
	s := useR2(f)
	share := r2Publish(t, f, s, 3)
	hash, e := hashSharePassword("1234")
	if e != nil {
		t.Fatal(e)
	}
	_, _ = f.a.db.Exec("UPDATE shares SET password_hash=? WHERE id=?", hash, share.ID)
	if w := f.request("POST", "/api/v1/shares/"+share.ID+"/download-sessions", nil, nil, false); w.Code != 401 {
		t.Fatal("password bypassed")
	}
	grant := f.request("POST", "/api/v1/shares/"+share.ID+"/unlock", map[string]any{"password": "1234"}, nil, false).Result().Cookies()[0]
	ticket := decodeResponse[map[string]any](t, f.request("POST", "/api/v1/shares/"+share.ID+"/download-sessions", nil, map[string]string{"Cookie": grant.String()}, false), 201)
	session := ticket["session"].(string)
	if w := f.request("POST", "/api/v1/shares/"+randomToken()+"/download-sessions/refresh", map[string]any{"session": session}, nil, false); w.Code != 401 {
		t.Fatal("cross-share session accepted")
	}
	future := time.Now().Add(6 * time.Minute)
	f.a.now = func() time.Time { return future }
	if w := f.request("POST", "/api/v1/shares/"+share.ID+"/download-sessions/refresh", map[string]any{"session": session}, nil, false); w.Code != 200 {
		t.Fatal("URL expiration destroyed session")
	}
	count(t, f.a, share.ID, 1)
	_, _ = f.a.db.Exec("UPDATE download_sessions SET last_activity=? WHERE token_hash=?", future.Add(-f.a.C.DownloadIdle).Unix(), tokenHash(session))
	if w := f.request("POST", "/api/v1/shares/"+share.ID+"/download-sessions/refresh", map[string]any{"session": session}, nil, false); w.Code != 410 {
		t.Fatal("idle session accepted")
	}
	_, _ = f.a.db.Exec("UPDATE download_sessions SET last_activity=?,expires=? WHERE token_hash=?", future.Unix(), future.Unix(), tokenHash(session))
	if w := f.request("POST", "/api/v1/shares/"+share.ID+"/download-sessions/refresh", map[string]any{"session": session}, nil, false); w.Code != 410 {
		t.Fatal("expired session accepted")
	}
}

func TestR2ObjectMetadataMismatchAndExpiredUpload(t *testing.T) {
	f := testApp(t)
	s := useR2(f)
	u := f.create(t, 7, "", 1)
	decodeResponse[Upload](t, f.request("GET", "/api/v1/uploads/"+u.ID, nil, nil, true), 200)
	_, _ = f.a.db.Exec("UPDATE uploads SET state='finalizing' WHERE id=?", u.ID)
	s.object = r2.Object{Size: 7, UploadID: "different-task", ETag: "etag"}
	if e := f.a.finalize(context.Background(), u.ID); e == nil {
		t.Fatal("published different task object")
	}
	var n int
	_ = f.a.db.QueryRow("SELECT count(*) FROM shares WHERE upload_id=?", u.ID).Scan(&n)
	if n != 0 {
		t.Fatal("mismatching object published")
	}
	_, _ = f.a.db.Exec("UPDATE uploads SET state='uploading',updated=? WHERE id=?", time.Now().Add(-f.a.C.UploadTTL-time.Minute).Unix(), u.ID)
	f.a.Cleanup()
	v, _ := f.a.upload(u.ID)
	if v.State != "cleaned" || s.aborted != 1 || s.deleted != 1 {
		t.Fatal("expired upload cleanup failed")
	}
}

func TestR2ShortSessionStillProtectsSignedURL(t *testing.T) {
	f := testApp(t)
	s := useR2(f)
	share := r2Publish(t, f, s, 1)
	f.a.C.DownloadMax = time.Minute
	f.a.C.DownloadIdle = time.Minute
	decodeResponse[map[string]any](t, f.request("POST", "/api/v1/shares/"+share.ID+"/download-sessions", nil, nil, false), 201)
	f.request("DELETE", "/api/v1/admin/shares/"+share.ID, nil, nil, true)
	future := time.Now().Add(2 * time.Minute)
	f.a.now = func() time.Time { return future }
	f.a.Cleanup()
	if s.deleted != 0 {
		t.Fatal("deleted before 5-minute URL expiry")
	}
	future = future.Add(4 * time.Minute)
	f.a.Cleanup()
	if s.deleted != 1 {
		t.Fatal("expired URL retained indefinitely")
	}
}

func TestSchemaOneMigrationPreservesLocalRecords(t *testing.T) {
	c, e := config.Load()
	if e != nil {
		t.Fatal(e)
	}
	c.DataDir = t.TempDir()
	db, e := sql.Open("sqlite", filepath.Join(c.DataDir, "parcel.db"))
	if e != nil {
		t.Fatal(e)
	}
	schema, _ := migrations.ReadFile("migrations/001.sql")
	if _, e = db.Exec(string(schema)); e != nil {
		t.Fatal(e)
	}
	_, e = db.Exec("INSERT INTO uploads(id,name,size,ttl,max_downloads,state,storage_key,share_id,created,updated) VALUES('legacy','legacy',0,3600,1,'cleaned','legacy-key','legacy-share',?,?)", time.Now().Unix(), time.Now().Unix())
	if e != nil {
		t.Fatal(e)
	}
	db.Close()
	a, e := New(c, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if e != nil {
		t.Fatal(e)
	}
	defer a.Close()
	u, e := a.upload("legacy")
	if e != nil || u.Backend != "local" {
		t.Fatal("migration changed legacy backend")
	}
	var version int
	_ = a.db.QueryRow("SELECT max(version) FROM schema_migrations").Scan(&version)
	if version != 4 {
		t.Fatal("migration not applied")
	}
}
