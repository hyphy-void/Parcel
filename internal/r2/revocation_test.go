package r2

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"os"
	"testing"
	"time"
)

// Real R2 regression for the one-part protocol. Use only unique probe keys;
// never log signed URLs or request errors that might contain them.
func TestLiveOnePartRevocation(t *testing.T) {
	path := os.Getenv("PARCEL_R2_LIVE_CREDENTIALS")
	if path == "" {
		t.Skip("opt-in live R2")
	}
	c, err := New(os.Getenv("PARCEL_R2_LIVE_ENDPOINT"), os.Getenv("PARCEL_R2_LIVE_BUCKET"), path)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	client := &http.Client{Timeout: 60 * time.Second}
	put := func(address string, body io.Reader, size int64) int {
		req, _ := http.NewRequestWithContext(ctx, "PUT", address, body)
		req.ContentLength = size
		req.Header.Set("Content-Type", "application/octet-stream")
		res, err := client.Do(req)
		if err != nil {
			return 0
		}
		_, _ = io.Copy(io.Discard, res.Body)
		res.Body.Close()
		return res.StatusCode
	}
	for _, size := range []int{0, 7, 1 << 20} {
		key := "parcel/probe/revocable-" + time.Now().UTC().Format("20060102T150405.000000000")
		id, err := c.Create(ctx, key, "revocation-probe")
		if err != nil {
			t.Fatal(err)
		}
		defer func() {
			if err := c.Abort(context.Background(), key, id); err != nil {
				t.Error("probe abort failed")
			}
			if err := c.Delete(context.Background(), key); err != nil {
				t.Error("probe delete failed")
			}
		}()
		address, err := c.SignPart(ctx, key, id, 1, int64(size))
		if err != nil {
			t.Fatal(err)
		}
		body := bytes.Repeat([]byte{'x'}, size)
		if size == 1<<20 {
			// Abort after the body has started, then allow the delayed body to finish.
			reader, writer := io.Pipe()
			result := make(chan int, 1)
			go func() { result <- put(address, reader, int64(size)); reader.Close() }()
			if _, err := writer.Write(body[:64<<10]); err != nil {
				t.Fatal("initial probe body failed")
			}
			if err := c.Abort(ctx, key, id); err != nil {
				t.Fatal(err)
			}
			_, _ = writer.Write(body[64<<10:])
			writer.Close()
			status := <-result
			t.Logf("aborted in-flight part returned HTTP %d", status)
			if _, err := c.Head(ctx, key); err != ErrNotFound {
				t.Fatal("aborted part created an object")
			}
			if _, err := c.Parts(ctx, key, id); err == nil {
				t.Fatal("aborted upload ID survived")
			}
		} else {
			if status := put(address, bytes.NewReader(body), int64(size)); status != 200 {
				t.Fatalf("one-part PUT status %d", status)
			}
			parts, err := c.Parts(ctx, key, id)
			if err != nil || len(parts) != 1 || parts[0].Size != int64(size) {
				t.Fatal("one-part size verification failed")
			}
			if err := c.Complete(ctx, key, id, parts); err != nil {
				t.Fatal(err)
			}
			object, err := c.Head(ctx, key)
			if err != nil || object.Size != int64(size) || object.UploadID != "revocation-probe" {
				t.Fatal("one-part publication verification failed")
			}
		}
		if status := put(address, bytes.NewReader(body), int64(size)); status < 400 {
			t.Fatalf("revoked URL accepted another PUT: HTTP %d", status)
		}
	}
}
