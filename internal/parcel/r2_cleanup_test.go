package parcel

import (
	"testing"
	"time"

	"github.com/hyphy-void/Parcel/internal/r2"
)

func TestSmallR2UploadUsesOneRevocablePart(t *testing.T) {
	for _, size := range []int64{0, 7, uploadConfirmationBytes} {
		f := testApp(t)
		store := useR2(f)
		f.a.C.MaxFile = 1 << 30
		f.a.C.Quota = 2 << 30
		f.a.C.R2Quota = max(1, size)
		u := f.create(t, size, "", 1)
		if isSinglePut(u) || u.PartBytes < max(1, u.Size) || partCount(u) != 1 {
			t.Fatalf("small upload must have one abortable part: %+v", u)
		}
		_, reserved, err := f.a.r2Usage()
		if err != nil || reserved != size {
			t.Fatalf("one-part reservation=%d want=%d err=%v", reserved, size, err)
		}
		decodeResponse[map[string]any](t, f.request("POST", "/api/v1/uploads/"+u.ID+"/parts/1", nil, nil, true), 200)
		store.parts = []r2.Part{{Number: 1, Size: size, ETag: "whole-part"}}
		decodeResponse[Upload](t, f.request("POST", "/api/v1/uploads/"+u.ID+"/complete", nil, nil, true), 202)
		waitPublished(t, f, u)
		if store.completed != 1 || store.copied != 0 {
			t.Fatal("one-part upload must complete without a staging copy")
		}
	}
}

func TestLegacyPutCleanupTracksLateObjects(t *testing.T) {
	for _, published := range []bool{false, true} {
		f := testApp(t)
		store := useR2(f)
		u := f.create(t, 7, "", 1)
		// Existing schema-3 single PUT tasks keep their original protocol.
		if _, err := f.a.db.Exec("UPDATE uploads SET part_bytes=0 WHERE id=?", u.ID); err != nil {
			t.Fatal(err)
		}
		decodeResponse[map[string]any](t, f.request("POST", "/api/v1/uploads/"+u.ID+"/object", nil, nil, true), 200)
		if published {
			store.staging = r2.Object{Size: 7, UploadID: u.ID, ETag: "initial"}
			decodeResponse[Upload](t, f.request("POST", "/api/v1/uploads/"+u.ID+"/complete", nil, nil, true), 202)
			waitPublished(t, f, u)
		} else {
			decodeResponse[map[string]any](t, f.request("DELETE", "/api/v1/uploads/"+u.ID, nil, nil, true), 200)
		}
		future := time.Now().Add(6 * time.Minute)
		f.a.now = func() time.Time { return future }
		f.a.Cleanup()
		store.staging = r2.Object{Size: 7, UploadID: u.ID, ETag: "late-commit"}
		future = future.Add(2 * time.Hour)
		f.a.Cleanup()
		if store.staging.ETag != "" {
			t.Fatal("late object was permanently forgotten after cleanup")
		}
		future = future.Add(8 * 24 * time.Hour)
		f.a.Cleanup()
		if _, err := f.a.upload(u.ID); err != nil {
			t.Fatal("legacy PUT cleanup tombstone must survive normal retention")
		}
	}
}
