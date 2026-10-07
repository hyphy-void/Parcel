package parcel

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/hyphy-void/Parcel/internal/config"
)

type fixture struct {
	a      *App
	h      http.Handler
	csrf   string
	cookie *http.Cookie
}

func testApp(t *testing.T) *fixture {
	t.Helper()
	c := config.Config{Listen: "127.0.0.1:8080", BaseURL: "http://127.0.0.1:8080", DataDir: t.TempDir(), MaxFile: 8 << 20, Quota: 32 << 20, MinFree: 0, Chunk: 16 << 10, UploadTTL: 24 * time.Hour, ShareTTL: time.Hour, MaxShareTTL: 7 * 24 * time.Hour, DownloadIdle: 30 * time.Minute, DownloadMax: 8 * time.Hour, CleanupInterval: time.Hour, DownloadLimit: 3}
	a, e := New(c, fstest.MapFS{"index.html": {Data: []byte("<h1>Parcel</h1>")}}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { a.Close() })
	if e = a.InitAdmin("test-password"); e != nil {
		t.Fatal(e)
	}
	f := &fixture{a: a, h: a.Handler()}
	w := f.request("POST", "/api/v1/auth/login", map[string]any{"password": "test-password"}, nil, false)
	if w.Code != 200 {
		t.Fatalf("login %d %s", w.Code, w.Body.String())
	}
	var v struct {
		CSRF string `json:"csrf"`
	}
	json.Unmarshal(w.Body.Bytes(), &v)
	f.csrf = v.CSRF
	f.cookie = w.Result().Cookies()[0]
	return f
}
func (f *fixture) request(method, path string, body any, headers map[string]string, admin bool) *httptest.ResponseRecorder {
	var data io.Reader
	if raw, ok := body.([]byte); ok {
		data = bytes.NewReader(raw)
	} else if body != nil {
		b, _ := json.Marshal(body)
		data = bytes.NewReader(b)
	}
	r := httptest.NewRequest(method, f.a.C.BaseURL+path, data)
	r.Header.Set("Origin", f.a.C.BaseURL)
	r.RemoteAddr = "192.168.5.20:1234"
	if admin {
		r.AddCookie(f.cookie)
		r.Header.Set("X-CSRF-Token", f.csrf)
	}
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	f.h.ServeHTTP(w, r)
	return w
}
func decodeResponse[T any](t *testing.T, w *httptest.ResponseRecorder, want int) T {
	t.Helper()
	if w.Code != want {
		t.Fatalf("status %d want %d: %s", w.Code, want, w.Body.String())
	}
	var v T
	if e := json.Unmarshal(w.Body.Bytes(), &v); e != nil {
		t.Fatal(e)
	}
	return v
}
func (f *fixture) create(t *testing.T, size int64, password string, limit int) Upload {
	t.Helper()
	return decodeResponse[Upload](t, f.request("POST", "/api/v1/uploads", map[string]any{"name": "示例文件.txt", "size": size, "password": password, "max_downloads": limit}, nil, true), 201)
}
func (f *fixture) publish(t *testing.T, data []byte, password string, limit int) Share {
	t.Helper()
	u := f.create(t, int64(len(data)), password, limit)
	for offset := 0; offset < len(data); {
		end := min(len(data), offset+int(f.a.C.Chunk))
		w := f.request("PATCH", "/api/v1/uploads/"+u.ID, data[offset:end], map[string]string{"Upload-Offset": fmt.Sprint(offset)}, true)
		if w.Code != 200 {
			t.Fatalf("patch %d: %s", w.Code, w.Body.String())
		}
		offset = end
	}
	w := f.request("POST", "/api/v1/uploads/"+u.ID+"/complete", nil, nil, true)
	if w.Code != 202 {
		t.Fatalf("complete %d %s", w.Code, w.Body.String())
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		current, e := f.a.upload(u.ID)
		if e != nil {
			t.Fatal(e)
		}
		if current.State == "completed" {
			s, e := f.a.share(u.ShareID)
			if e != nil {
				t.Fatal(e)
			}
			return s
		}
		if current.State == "failed" {
			t.Fatal(current.Error)
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("finalization timeout")
	return Share{}
}
func (f *fixture) ticket(t *testing.T, id string, grant *http.Cookie) string {
	t.Helper()
	headers := map[string]string{}
	if grant != nil {
		headers["Cookie"] = grant.String()
	}
	v := decodeResponse[map[string]any](t, f.request("POST", "/api/v1/shares/"+id+"/download-sessions", nil, headers, false), 201)
	return v["url"].(string)
}
func count(t *testing.T, a *App, id string, want int) {
	t.Helper()
	s, e := a.share(id)
	if e != nil || s.DownloadCount != want {
		t.Fatalf("count=%d want %d err %v", s.DownloadCount, want, e)
	}
}

func TestAuthAndBoundaries(t *testing.T) {
	f := testApp(t)
	cases := []struct {
		method, path string
		head         map[string]string
		admin        bool
		status       int
	}{{"POST", "/api/v1/uploads", nil, false, 401}, {"POST", "/api/v1/uploads", map[string]string{"Origin": "http://evil.example"}, true, 403}, {"POST", "/api/v1/uploads", map[string]string{"X-CSRF-Token": "bad"}, true, 403}}
	for _, c := range cases {
		w := f.request(c.method, c.path, map[string]any{"name": "a", "size": 0}, c.head, c.admin)
		if w.Code != c.status {
			t.Fatalf("%d want %d", w.Code, c.status)
		}
	}
	r := httptest.NewRequest("GET", "http://evil.example/healthz", nil)
	w := httptest.NewRecorder()
	f.h.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("host allowed")
	}
	if w = f.request("GET", "/s/a", nil, nil, false); w.Code != 200 || !strings.Contains(w.Body.String(), "Parcel") {
		t.Fatal("SPA fallback")
	}
	if w = f.request("GET", "/api/v1/unknown", nil, nil, false); w.Code != 404 {
		t.Fatal("API fallback leaked frontend")
	}
	if _, e := New(f.a.C, nil, nil); e == nil {
		t.Fatal("second process acquired directory")
	}
	w = f.request("POST", "/api/v1/auth/logout", nil, nil, true)
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	if w = f.request("GET", "/api/v1/admin/status", nil, nil, true); w.Code != 401 {
		t.Fatal("logged out session valid")
	}
}
func TestUploadOffsetSizeAndQuota(t *testing.T) {
	f := testApp(t)
	u := f.create(t, 5, "", 1)
	path := "/api/v1/uploads/" + u.ID
	headers := map[string]string{"Upload-Offset": "0"}
	if w := f.request("PATCH", path, []byte("abcdef"), headers, true); w.Code != 413 {
		t.Fatal(w.Code)
	}
	if w := f.request("PATCH", path, []byte("abc"), headers, true); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if w := f.request("PATCH", path, []byte("abc"), headers, true); w.Code != 409 || w.Header().Get("Upload-Offset") != "3" {
		t.Fatal(w.Code)
	}
	if w := f.request("POST", path+"/complete", nil, nil, true); w.Code != 409 {
		t.Fatal(w.Code)
	}
	f.a.C.Quota = 8
	if w := f.request("POST", "/api/v1/uploads", map[string]any{"name": "b", "size": 4}, nil, true); w.Code != 507 {
		t.Fatal(w.Code)
	}
	f.a.freeBytes = func() (int64, error) { return -1, nil }
	if w := f.request("PATCH", path, []byte("de"), map[string]string{"Upload-Offset": "3"}, true); w.Code != 507 {
		t.Fatal(w.Code)
	}
	current, _ := f.a.upload(u.ID)
	if current.Offset != 3 {
		t.Fatal(current.Offset)
	}
	if w := f.request("POST", "/api/v1/uploads", map[string]any{"name": "../../a", "size": 0}, nil, true); w.Code != 400 {
		t.Fatal(w.Code)
	}
}
func TestUploadIdempotencyAndCompletion(t *testing.T) {
	f := testApp(t)
	body := map[string]any{"name": "empty", "size": 0}
	head := map[string]string{"Idempotency-Key": "unique"}
	u := decodeResponse[Upload](t, f.request("POST", "/api/v1/uploads", body, head, true), 201)
	looked := decodeResponse[Upload](t, f.request("GET", "/api/v1/uploads/lookup", nil, head, true), 200)
	if looked.ID != u.ID {
		t.Fatal("lost creation response could not be recovered")
	}
	again := decodeResponse[Upload](t, f.request("POST", "/api/v1/uploads", body, head, true), 200)
	if u.ID != again.ID {
		t.Fatal("duplicate upload")
	}
	w := f.request("POST", "/api/v1/uploads/"+u.ID+"/complete", nil, nil, true)
	if w.Code != 202 {
		t.Fatal(w.Code)
	}
	for i := 0; i < 100; i++ {
		v, _ := f.a.upload(u.ID)
		if v.State == "completed" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	v := decodeResponse[Upload](t, f.request("POST", "/api/v1/uploads/"+u.ID+"/complete", nil, nil, true), 200)
	s, e := f.a.share(v.ShareID)
	if e != nil {
		t.Fatal(e)
	}
	url := f.ticket(t, s.ID, nil)
	if w := f.request("GET", url, nil, nil, false); w.Code != 200 || w.Body.Len() != 0 {
		t.Fatal(w.Code)
	}
	count(t, f.a, s.ID, 1)
}

type pausedWriter struct {
	*httptest.ResponseRecorder
	entered, release chan struct{}
	once             sync.Once
}

func (w *pausedWriter) Write(b []byte) (int, error) {
	w.once.Do(func() { close(w.entered) })
	<-w.release
	return w.ResponseRecorder.Write(b)
}
func TestExpiryCleanupWaitsForActiveStream(t *testing.T) {
	f := testApp(t)
	s := f.publish(t, bytes.Repeat([]byte("a"), 64<<10), "", 1)
	url := f.ticket(t, s.ID, nil)
	writer := &pausedWriter{ResponseRecorder: httptest.NewRecorder(), entered: make(chan struct{}), release: make(chan struct{})}
	done := make(chan struct{})
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(writer.release) }) }
	t.Cleanup(unblock)
	request := httptest.NewRequest("GET", f.a.C.BaseURL+url, nil)
	go func() { f.h.ServeHTTP(writer, request); close(done) }()
	select {
	case <-writer.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("stream did not enter")
	}
	f.a.mu.Lock()
	_, e := f.a.db.Exec("UPDATE shares SET expires=? WHERE id=?", f.a.now().Unix()-1, s.ID)
	f.a.mu.Unlock()
	if e != nil {
		t.Fatal(e)
	}
	f.a.Cleanup()
	st, _ := f.a.share(s.ID)
	if st.State != "active" {
		t.Fatal("deleted while stream held file")
	}
	if w := f.request("GET", url, nil, nil, false); w.Code != 410 {
		t.Fatal("new request admitted after expiry")
	}
	unblock()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("stream did not finish")
	}
	if writer.Body.Len() != 64<<10 {
		t.Fatal("expiry interrupted the already admitted stream")
	}
	f.a.Cleanup()
	st, _ = f.a.share(s.ID)
	if st.State != "deleted" {
		t.Fatal(st.State)
	}
}
func TestPasswordMetadataAndRevocation(t *testing.T) {
	f := testApp(t)
	s := f.publish(t, []byte("secret payload"), "share-password", 3)
	w := f.request("GET", "/api/v1/shares/"+s.ID, nil, nil, false)
	if strings.Contains(w.Body.String(), s.Name) || strings.Contains(w.Body.String(), "secret payload") {
		t.Fatal("metadata leaked")
	}
	if w = f.request("POST", "/api/v1/shares/"+s.ID+"/download-sessions", nil, nil, false); w.Code != 401 {
		t.Fatal(w.Code)
	}
	w = f.request("POST", "/api/v1/shares/"+s.ID+"/unlock", map[string]string{"password": "wrong"}, nil, false)
	if w.Code != 401 {
		t.Fatal(w.Code)
	}
	w = f.request("POST", "/api/v1/shares/"+s.ID+"/unlock", map[string]string{"password": "share-password"}, nil, false)
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	grant := w.Result().Cookies()[0]
	ticket := f.ticket(t, s.ID, grant)
	if w = f.request("PATCH", "/api/v1/admin/shares/"+s.ID+"/password", map[string]string{"password": "changed-password"}, nil, true); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if w = f.request("GET", ticket, nil, nil, false); w.Code != 410 {
		t.Fatal(w.Code)
	}
	if w = f.request("POST", "/api/v1/shares/"+s.ID+"/download-sessions", nil, map[string]string{"Cookie": grant.String()}, false); w.Code != 401 {
		t.Fatal(w.Code)
	}
	if w = f.request("DELETE", "/api/v1/admin/shares/"+s.ID, nil, nil, true); w.Code != 200 {
		t.Fatal(w.Code)
	}
	f.a.Cleanup()
	st, _ := f.a.share(s.ID)
	if st.State != "deleted" {
		t.Fatal(st.State)
	}
	if _, e := os.Stat(filepath.Join(f.a.C.DataDir, "files", s.StorageKey)); !os.IsNotExist(e) {
		t.Fatal(e)
	}
}
func TestRangeConditionalAndCounting(t *testing.T) {
	f := testApp(t)
	data := bytes.Repeat([]byte("0123456789"), 10000)
	s := f.publish(t, data, "", 2)
	url := f.ticket(t, s.ID, nil)
	hash := sha256.Sum256(data)
	if s.SHA256 != hex.EncodeToString(hash[:]) {
		t.Fatal("hash mismatch")
	}
	w := f.request("HEAD", url, nil, nil, false)
	if w.Code != 200 || w.Body.Len() != 0 {
		t.Fatal(w.Code)
	}
	count(t, f.a, s.ID, 0)
	etag := w.Header().Get("ETag")
	w = f.request("GET", url, nil, map[string]string{"If-None-Match": etag}, false)
	if w.Code != 304 {
		t.Fatal(w.Code)
	}
	count(t, f.a, s.ID, 0)
	for _, rangeValue := range []string{"bytes=999999-", "bytes=0-1,4-5"} {
		w = f.request("GET", url, nil, map[string]string{"Range": rangeValue}, false)
		if w.Code != 416 {
			t.Fatal(w.Code)
		}
	}
	count(t, f.a, s.ID, 0)
	w = f.request("GET", url, nil, map[string]string{"Range": "bytes=3-12"}, false)
	if w.Code != 206 || !bytes.Equal(w.Body.Bytes(), data[3:13]) || w.Header().Get("Content-Range") != "bytes 3-12/100000" {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	count(t, f.a, s.ID, 1)
	w = f.request("GET", url, nil, map[string]string{"Range": "bytes=13-", "If-Range": etag}, false)
	if w.Code != 206 || !bytes.Equal(w.Body.Bytes(), data[13:]) {
		t.Fatal(w.Code)
	}
	count(t, f.a, s.ID, 1)
	w = f.request("GET", url, nil, map[string]string{"Range": "bytes=3-12", "If-Range": "\"different\""}, false)
	if w.Code != 200 || !bytes.Equal(w.Body.Bytes(), data) {
		t.Fatal(w.Code)
	}
	count(t, f.a, s.ID, 1)
}
func TestConcurrentAdmissionAndExhaustedResume(t *testing.T) {
	f := testApp(t)
	s := f.publish(t, []byte("data"), "", 1)
	var urls []string
	for i := 0; i < 20; i++ {
		urls = append(urls, f.ticket(t, s.ID, nil))
	}
	var wg sync.WaitGroup
	var mu sync.Mutex
	var winner string
	success := 0
	for _, url := range urls {
		wg.Add(1)
		go func(url string) {
			defer wg.Done()
			w := f.request("GET", url, nil, nil, false)
			mu.Lock()
			defer mu.Unlock()
			if w.Code == 200 {
				success++
				winner = url
			} else if w.Code != 410 && w.Code != 503 {
				t.Errorf("unexpected %d", w.Code)
			}
		}(url)
	}
	wg.Wait()
	if success != 1 {
		t.Fatalf("success %d", success)
	}
	count(t, f.a, s.ID, 1)
	f.a.Cleanup()
	st, _ := f.a.share(s.ID)
	if st.State != "active" {
		t.Fatal("deleted resumable file")
	}
	w := f.request("GET", winner, nil, map[string]string{"Range": "bytes=2-"}, false)
	if w.Code != 206 || w.Body.String() != "ta" {
		t.Fatal(w.Code)
	}
	count(t, f.a, s.ID, 1)
	if w = f.request("POST", "/api/v1/shares/"+s.ID+"/download-sessions", nil, nil, false); w.Code != 410 {
		t.Fatal(w.Code)
	}
}
func TestSameTicketConcurrentActivation(t *testing.T) {
	f := testApp(t)
	s := f.publish(t, []byte("data"), "", 10)
	url := f.ticket(t, s.ID, nil)
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			w := f.request("GET", url, nil, nil, false)
			if w.Code != 200 && w.Code != 503 {
				t.Errorf("%d", w.Code)
			}
		}()
	}
	wg.Wait()
	count(t, f.a, s.ID, 1)
}
func TestExpiryAndCleanupRetry(t *testing.T) {
	f := testApp(t)
	s := f.publish(t, []byte("data"), "", 2)
	url := f.ticket(t, s.ID, nil)
	f.a.db.Exec("UPDATE shares SET expires=? WHERE id=?", f.a.now().Unix()-1, s.ID)
	if w := f.request("GET", url, nil, nil, false); w.Code != 410 {
		t.Fatal(w.Code)
	}
	p := filepath.Join(f.a.C.DataDir, "files", s.StorageKey)
	os.Remove(p)
	os.Mkdir(p, 0700)
	os.WriteFile(filepath.Join(p, "busy"), []byte("x"), 0600)
	f.a.Cleanup()
	st, _ := f.a.share(s.ID)
	if st.State != "deleting" {
		t.Fatal(st.State)
	}
	used, _, _, _ := f.a.usage()
	if used != 4 {
		t.Fatal("released quota before deletion")
	}
	os.Remove(filepath.Join(p, "busy"))
	os.Remove(p)
	f.a.db.Exec("UPDATE shares SET retry_at=0 WHERE id=?", s.ID)
	f.a.Cleanup()
	f.a.Cleanup()
	st, _ = f.a.share(s.ID)
	if st.State != "deleted" {
		t.Fatal(st.State)
	}
	used, _, _, _ = f.a.usage()
	if used != 0 {
		t.Fatal(used)
	}
}
func TestRecoveryTailAndMovedFile(t *testing.T) {
	f := testApp(t)
	u := f.create(t, 5, "", 2)
	f.request("PATCH", "/api/v1/uploads/"+u.ID, []byte("abc"), map[string]string{"Upload-Offset": "0"}, true)
	p := filepath.Join(f.a.C.DataDir, "tmp", u.ID+".part")
	file, e := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0600)
	if e != nil {
		t.Fatal(e)
	}
	file.WriteString("unacknowledged")
	file.Close()
	if e = f.a.recover(); e != nil {
		t.Fatal(e)
	}
	st, _ := os.Stat(p)
	if st.Size() != 3 {
		t.Fatal(st.Size())
	}
	f.request("PATCH", "/api/v1/uploads/"+u.ID, []byte("de"), map[string]string{"Upload-Offset": "3"}, true)
	f.a.db.Exec("UPDATE uploads SET state='finalizing' WHERE id=?", u.ID)
	f.a.root.Rename("tmp/"+u.ID+".part", "files/"+u.StorageKey)
	if e = f.a.recover(); e != nil {
		t.Fatal(e)
	}
	if e = f.a.finalize(context.Background(), u.ID); e != nil {
		t.Fatal(e)
	}
	s, e := f.a.share(u.ShareID)
	if e != nil || s.Size != 5 {
		t.Fatal(e)
	}
	if e = f.a.finalize(context.Background(), u.ID); e != nil {
		t.Fatal(e)
	}
	var n int
	f.a.db.QueryRow("SELECT count(*) FROM shares WHERE upload_id=?", u.ID).Scan(&n)
	if n != 1 {
		t.Fatal(n)
	}
}
func TestMissingFileOrphanAndCanceledQuota(t *testing.T) {
	f := testApp(t)
	u := f.create(t, 10, "", 1)
	if w := f.request("DELETE", "/api/v1/uploads/"+u.ID, nil, nil, true); w.Code != 200 {
		t.Fatal(w.Code)
	}
	_, reserved, _, _ := f.a.usage()
	if reserved != 10 {
		t.Fatal("released before removal")
	}
	f.a.Cleanup()
	_, reserved, _, _ = f.a.usage()
	if reserved != 0 {
		t.Fatal(reserved)
	}
	s := f.publish(t, []byte("file"), "", 1)
	os.Remove(filepath.Join(f.a.C.DataDir, "files", s.StorageKey))
	if e := f.a.recover(); e != nil {
		t.Fatal(e)
	}
	s, _ = f.a.share(s.ID)
	if s.State != "deleted" {
		t.Fatal(s.State)
	}
	orphan := filepath.Join(f.a.C.DataDir, "tmp", "orphan.part")
	os.WriteFile(orphan, []byte("orphan"), 0600)
	os.Chtimes(orphan, time.Now().Add(-2*time.Hour), time.Now().Add(-2*time.Hour))
	f.a.Cleanup()
	if _, e := os.Stat(orphan); !os.IsNotExist(e) {
		t.Fatal(e)
	}
}
func TestMissingMountAndSymlinkEscape(t *testing.T) {
	f := testApp(t)
	c := f.a.C
	c.DataDir = filepath.Join(t.TempDir(), "not-created")
	c.RequiredMount = t.TempDir()
	if _, e := New(c, nil, nil); e == nil {
		t.Fatal("accepted absent mount")
	}
	if _, e := os.Stat(c.DataDir); !os.IsNotExist(e) {
		t.Fatal("created directory before mount check")
	}
	outside := filepath.Join(t.TempDir(), "private")
	os.WriteFile(outside, []byte("private"), 0600)
	key := randomToken()
	os.Symlink(outside, filepath.Join(f.a.C.DataDir, "files", key))
	if _, e := f.a.root.Open("files/" + key); e == nil {
		t.Fatal("symlink escaped root")
	}
}
