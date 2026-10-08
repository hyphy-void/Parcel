package parcel

import (
	"context"
	"github.com/hyphy-void/Parcel/internal/r2"
	"strings"
	"testing"
	"time"
)

func waitPublished(t *testing.T, f *fixture, u Upload) Share {
	t.Helper()
	for range 200 {
		v, _ := f.a.upload(u.ID)
		if v.State == "completed" {
			s, err := f.a.share(u.ShareID)
			if err != nil {
				t.Fatal(err)
			}
			return s
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("single PUT publication timed out")
	return Share{}
}
func TestSinglePutValidationPublicationAndRetention(t *testing.T) {
	f := testApp(t)
	store := useR2(f)
	u := f.create(t, 7, "", 2)
	if !isSinglePut(u) {
		t.Fatal("small upload did not select PUT")
	}
	if w := f.request("POST", "/api/v1/uploads/"+u.ID+"/object", nil, nil, false); w.Code != 401 {
		t.Fatal("unauthorized sign")
	}
	sign := decodeResponse[map[string]any](t, f.request("POST", "/api/v1/uploads/"+u.ID+"/object", nil, nil, true), 200)
	if sign["expires"].(float64)-float64(f.a.now().Unix()) != 300 {
		t.Fatal("PUT lifetime")
	}
	if w := f.request("POST", "/api/v1/uploads/"+u.ID+"/parts/1", nil, nil, true); w.Code != 409 {
		t.Fatal("single upload admitted multipart")
	}
	for _, o := range []r2.Object{{}, {Size: 6, UploadID: u.ID, ETag: "size"}, {Size: 7, UploadID: "other", ETag: "task"}} {
		store.staging = o
		if w := f.request("POST", "/api/v1/uploads/"+u.ID+"/complete", nil, nil, true); w.Code != 409 {
			t.Fatal("invalid staging object accepted", w.Code)
		}
	}
	store.staging = r2.Object{Size: 7, UploadID: u.ID, ETag: "verified"}
	progress := decodeResponse[Upload](t, f.request("GET", "/api/v1/uploads/"+u.ID, nil, nil, true), 200)
	if progress.Offset != 7 || !progress.ObjectUploaded {
		t.Fatal("completed PUT not recovered")
	}
	decodeResponse[Upload](t, f.request("POST", "/api/v1/uploads/"+u.ID+"/complete", nil, nil, true), 202)
	s := waitPublished(t, f, u)
	if s.Backend != "r2" || s.SHA256 != "" || store.copied != 1 || store.completed != 0 {
		t.Fatal("single PUT publication used multipart or wrong integrity")
	}
	if w := f.request("POST", "/api/v1/uploads/"+u.ID+"/object", nil, nil, true); w.Code != 409 {
		t.Fatal("signed published PUT")
	}
	f.a.Cleanup()
	if store.stagingDeleted != 0 {
		t.Fatal("deleted staging before PUT URL expiry")
	}
	future := time.Now().Add(6 * time.Minute)
	f.a.now = func() time.Time { return future }
	f.a.Cleanup()
	if store.stagingDeleted != 1 {
		t.Fatal("staging cleanup failed")
	}
	_, reserved, err := f.a.r2Usage()
	if err != nil || reserved != 0 {
		t.Fatal("staging budget not released")
	}
}
func TestSinglePutZeroBytesAndCopyCrashRecovery(t *testing.T) {
	for _, copied := range []bool{false, true} {
		f := testApp(t)
		store := useR2(f)
		u := f.create(t, 0, "", 1)
		store.staging = r2.Object{Size: 0, UploadID: u.ID, ETag: "zero"}
		v := decodeResponse[Upload](t, f.request("GET", "/api/v1/uploads/"+u.ID, nil, nil, true), 200)
		if !v.ObjectUploaded {
			t.Fatal("zero-byte PUT treated as absent")
		}
		if copied {
			store.object = store.staging
			store.staging = r2.Object{}
		}
		_, _ = f.a.db.Exec("UPDATE uploads SET state='finalizing' WHERE id=?", u.ID)
		if err := f.a.finalize(context.Background(), u.ID); err != nil {
			t.Fatal(err)
		}
		s, _ := f.a.share(u.ShareID)
		if s.State != "active" || s.Size != 0 {
			t.Fatal("empty publication")
		}
		if copied && store.copied != 0 {
			t.Fatal("copied twice after crash")
		}
	}
}
func TestR2StorageGuardReservationsAndCancel(t *testing.T) {
	f := testApp(t)
	f.publish(t, []byte("legacy"), "", 1)
	store := useR2(f)
	f.a.C.R2Quota = 14
	u := f.create(t, 7, "", 1)
	used, reserved, err := f.a.r2Usage()
	if err != nil || used != 0 || reserved != 14 {
		t.Fatal("R2 storage guard must exclude local and reserve both copies")
	}
	if w := f.request("POST", "/api/v1/uploads", map[string]any{"name": "extra", "size": 1}, nil, true); w.Code != 507 || !strings.Contains(w.Body.String(), "r2_quota_exceeded") {
		t.Fatal("guard failed")
	}
	f.request("POST", "/api/v1/uploads/"+u.ID+"/object", nil, nil, true)
	f.request("DELETE", "/api/v1/uploads/"+u.ID, nil, nil, true)
	f.a.Cleanup()
	_, reserved, _ = f.a.r2Usage()
	if reserved != 14 {
		t.Fatal("released budget while signed PUT remained usable")
	}
	future := time.Now().Add(6 * time.Minute)
	f.a.now = func() time.Time { return future }
	f.a.Cleanup()
	_, reserved, _ = f.a.r2Usage()
	if reserved != 0 || store.aborted != 0 {
		t.Fatal("single PUT cancel cleanup failed")
	}
}
func TestClearCleanedHistoryPreservesRetainedObjects(t *testing.T) {
	f := testApp(t)
	active := f.publish(t, []byte("active"), "", 2)
	cleaned := f.publish(t, []byte("gone"), "", 2)
	retained := f.publish(t, []byte("retained"), "", 2)
	f.request("DELETE", "/api/v1/admin/shares/"+cleaned.ID, nil, nil, true)
	f.a.Cleanup()
	f.request("DELETE", "/api/v1/admin/shares/"+retained.ID, nil, nil, true)
	if w := f.request("DELETE", "/api/v1/admin/shares/cleaned", nil, nil, false); w.Code != 401 {
		t.Fatal("unauthorized history clearing")
	}
	result := decodeResponse[map[string]any](t, f.request("DELETE", "/api/v1/admin/shares/cleaned", nil, nil, true), 200)
	if result["removed"].(float64) != 1 {
		t.Fatal("wrong cleared count")
	}
	if _, err := f.a.share(cleaned.ID); err == nil {
		t.Fatal("cleaned record retained")
	}
	for _, id := range []string{active.ID, retained.ID} {
		if _, err := f.a.share(id); err != nil {
			t.Fatal("live/retained record removed")
		}
	}
	used, _, _, _ := f.a.usage()
	if used != int64(len("active")+len("retained")) {
		t.Fatal("clearing history changed quota")
	}
}
