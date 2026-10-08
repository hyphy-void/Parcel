package r2

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

func TestCredentials(t *testing.T) {
	for _, text := range []string{"Access Key ID:\nexample\nSecret Access Key:\nsecret\n", "ACCESS_KEY_ID=example\nSECRET_ACCESS_KEY=secret\n", "Access Key ID: example\nSecret Access Key: secret\n"} {
		path := filepath.Join(t.TempDir(), "credentials")
		if e := os.WriteFile(path, []byte(text), 0600); e != nil {
			t.Fatal(e)
		}
		key, secret, e := Credentials(path)
		if e != nil || key != "example" || secret != "secret" {
			t.Fatal("credential parsing failed")
		}
		_ = os.Chmod(path, 0644)
		if _, _, e = Credentials(path); e == nil {
			t.Fatal("insecure permissions accepted")
		}
	}
}

// Opt-in real bucket verification; never print credentials, signed URLs or SDK
// request errors. Only random parcel/probe objects are created and removed.
func TestLiveR2(t *testing.T) {
	path := os.Getenv("PARCEL_R2_LIVE_CREDENTIALS")
	if path == "" {
		t.Skip("set PARCEL_R2_LIVE_CREDENTIALS to run live R2 verification")
	}
	endpoint := os.Getenv("PARCEL_R2_LIVE_ENDPOINT")
	bucket := os.Getenv("PARCEL_R2_LIVE_BUCKET")
	c, e := New(endpoint, bucket, path)
	if e != nil {
		t.Fatal(e)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	key := "parcel/probe/" + time.Now().UTC().Format("20060102T150405.000000000")
	id, e := c.Create(ctx, key, "probe")
	if e != nil {
		t.Fatal(e)
	}
	defer func() {
		if e := c.Abort(context.Background(), key, id); e != nil {
			t.Error("probe abort failed")
		}
		if e := c.Delete(context.Background(), key); e != nil {
			t.Error("probe deletion failed")
		}
	}()
	httpClient := &http.Client{Timeout: 90 * time.Second}
	for i, size := range []int{int(PartSize), 1024} {
		address, e := c.SignPart(ctx, key, id, int32(i+1), int64(size))
		if e != nil {
			t.Fatal(e)
		}
		req, _ := http.NewRequestWithContext(ctx, "PUT", address, bytes.NewReader(bytes.Repeat([]byte{'x'}, size)))
		req.Header.Set("Content-Type", "application/octet-stream")
		req.Header.Set("Origin", "https://parcel.playereconlab.com")
		res, e := httpClient.Do(req)
		if e != nil {
			t.Fatal("signed PUT transport failed")
		}
		_, _ = io.Copy(io.Discard, res.Body)
		res.Body.Close()
		if res.StatusCode != 200 {
			t.Fatalf("signed PUT status %d", res.StatusCode)
		}
		if res.Header.Get("ETag") == "" {
			t.Fatal("missing part ETag")
		}
		if res.Header.Get("Access-Control-Allow-Origin") != "https://parcel.playereconlab.com" || !strings.Contains(strings.ToLower(res.Header.Get("Access-Control-Expose-Headers")), "etag") {
			t.Error("PUT CORS / exposed ETag is missing")
		}
	}
	parts, e := c.Parts(ctx, key, id)
	if e != nil {
		t.Fatal(e)
	}
	if len(parts) != 2 || parts[0].Size != PartSize || parts[1].Size != 1024 {
		t.Fatal("ListParts verification failed")
	}
	if e = c.Complete(ctx, key, id, parts); e != nil {
		t.Fatal(e)
	}
	object, e := c.Head(ctx, key)
	if e != nil {
		t.Fatal(e)
	}
	if object.Size != PartSize+1024 || object.UploadID != "probe" || !strings.HasSuffix(object.ETag, "-2\"") {
		t.Fatal("HEAD verification failed")
	}
	address, e := c.SignGet(ctx, key, "测试文件.txt")
	if e != nil {
		t.Fatal(e)
	}
	req, _ := http.NewRequestWithContext(ctx, "GET", address, nil)
	req.Header.Set("Range", "bytes=10-19")
	req.Header.Set("Origin", "https://parcel.playereconlab.com")
	res, e := httpClient.Do(req)
	if e != nil {
		t.Fatal("signed GET transport failed")
	}
	b, _ := io.ReadAll(io.LimitReader(res.Body, 64))
	res.Body.Close()
	if res.StatusCode != 206 || string(b) != "xxxxxxxxxx" || !strings.Contains(res.Header.Get("Content-Disposition"), "attachment") {
		t.Fatal("GET Range / filename verification failed")
	}
	// Verify CORS preflight using the real browser request headers.
	req, _ = http.NewRequestWithContext(ctx, "OPTIONS", address, nil)
	req.Header.Set("Origin", "https://parcel.playereconlab.com")
	req.Header.Set("Access-Control-Request-Method", "PUT")
	req.Header.Set("Access-Control-Request-Headers", "content-type")
	res, e = httpClient.Do(req)
	if e != nil {
		t.Fatal("CORS preflight transport failed")
	}
	res.Body.Close()
	if res.Header.Get("Access-Control-Allow-Origin") != "https://parcel.playereconlab.com" {
		t.Error("CORS production origin is not configured")
	} else {
		t.Log("CORS production origin verified")
	}
	// Object read/write tokens may not authorize bucket settings. Inspect without
	// replacing an existing CORS policy or making the bucket public.
	cors, e := c.S3.GetBucketCors(ctx, &s3.GetBucketCorsInput{Bucket: aws.String(bucket)})
	if e != nil {
		t.Log("bucket CORS inspection:", safe(e))
	} else {
		t.Logf("bucket has %d CORS rules", len(cors.CORSRules))
	}
	if e = c.Delete(ctx, key); e != nil {
		t.Fatal(e)
	}
	if _, e = c.Head(ctx, key); e != ErrNotFound {
		t.Fatal("deleted probe still accessible")
	}
	emptyKey := key + "-empty"
	emptyID, e := c.Create(ctx, emptyKey, "empty-probe")
	if e != nil {
		t.Fatal(e)
	}
	defer func() {
		_ = c.Abort(context.Background(), emptyKey, emptyID)
		_ = c.Delete(context.Background(), emptyKey)
	}()
	address, e = c.SignPart(ctx, emptyKey, emptyID, 1, 0)
	if e != nil {
		t.Fatal(e)
	}
	req, _ = http.NewRequestWithContext(ctx, "PUT", address, bytes.NewReader(nil))
	res, e = httpClient.Do(req)
	if e != nil {
		t.Fatal("empty part transport failed")
	}
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("empty part status %d", res.StatusCode)
	}
	emptyParts, e := c.Parts(ctx, emptyKey, emptyID)
	if e != nil {
		t.Fatal(e)
	}
	if e = c.Complete(ctx, emptyKey, emptyID, emptyParts); e != nil {
		t.Fatal(e)
	}
	emptyObject, e := c.Head(ctx, emptyKey)
	if e != nil || emptyObject.Size != 0 || emptyObject.UploadID != "empty-probe" {
		t.Fatal("empty object verification failed")
	}
	abortKey := key + "-abort"
	abortID, e := c.Create(ctx, abortKey, "abort-probe")
	if e != nil {
		t.Fatal(e)
	}
	defer func() { _ = c.Abort(context.Background(), abortKey, abortID) }()
	if e = c.Abort(ctx, abortKey, abortID); e != nil {
		t.Fatal(e)
	}
	if _, e = c.Parts(ctx, abortKey, abortID); e != ErrNotFound {
		t.Fatal("multipart abort verification failed")
	}
	t.Log("verified Multipart PUT, ListParts, Complete, HEAD, GET Range, filename, production CORS, zero-byte upload, abort and deletion")
}

func TestPresignConstraints(t *testing.T) {
	path := filepath.Join(t.TempDir(), "credentials")
	_ = os.WriteFile(path, []byte("ACCESS_KEY_ID=example\nSECRET_ACCESS_KEY=secret\n"), 0600)
	c, e := New("https://test.r2.cloudflarestorage.com", "parcel", path)
	if e != nil {
		t.Fatal(e)
	}
	address, e := c.SignPart(context.Background(), "object", "upload", 1, 123)
	if e != nil {
		t.Fatal(e)
	}
	// Never print the signed URL, even for an assertion failure.
	u, e := url.Parse(address)
	if e != nil {
		t.Fatal("invalid URL")
	}
	if !strings.Contains(u.Query().Get("X-Amz-SignedHeaders"), "content-length") {
		t.Fatal("part Content-Length is not signed")
	}
	if u.Query().Get("X-Amz-Expires") != "300" {
		t.Fatal("wrong upload URL TTL")
	}
	address, e = c.SignGet(context.Background(), "object", "中文.txt")
	if e != nil {
		t.Fatal(e)
	}
	u, _ = url.Parse(address)
	if u.Query().Get("X-Amz-Expires") != "300" || !strings.Contains(u.Query().Get("response-content-disposition"), "attachment") {
		t.Fatal("download constraints missing")
	}
}

func TestSinglePutPresign(t *testing.T) {
	path := filepath.Join(t.TempDir(), "credentials")
	_ = os.WriteFile(path, []byte("ACCESS_KEY_ID=example\nSECRET_ACCESS_KEY=secret\n"), 0600)
	c, err := New("https://test.r2.cloudflarestorage.com", "parcel", path)
	if err != nil {
		t.Fatal(err)
	}
	address, headers, err := c.SignPut(context.Background(), "object.pending", "task", 100_000_000)
	if err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(address)
	if err != nil {
		t.Fatal("invalid PUT URL")
	}
	if u.Query().Get("X-Amz-Expires") != "300" || !strings.Contains(u.Query().Get("X-Amz-SignedHeaders"), "content-length") {
		t.Fatal("PUT expiry/size are not signed")
	}
	if u.Query().Get("X-Amz-Meta-Parcel-Upload") != "task" && u.Query().Get("x-amz-meta-parcel-upload") != "task" && headers["X-Amz-Meta-Parcel-Upload"] != "task" {
		t.Fatal("task metadata is not included in presign")
	}
	for name := range headers {
		t.Log("required browser PUT header:", name)
	}
}

func TestLiveSinglePut(t *testing.T) {
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
	key := "parcel/probe/put-" + time.Now().UTC().Format("20060102T150405.000000000")
	client := &http.Client{Timeout: 90 * time.Second}
	for _, body := range [][]byte{nil, []byte("verified PUT object")} {
		stage := key + ".pending"
		defer func() { _ = c.Delete(context.Background(), stage); _ = c.Delete(context.Background(), key) }()
		address, headers, e := c.SignPut(ctx, stage, "put-probe", int64(len(body)))
		if e != nil {
			t.Fatal(e)
		}
		preflight, _ := http.NewRequestWithContext(ctx, "OPTIONS", address, nil)
		preflight.Header.Set("Origin", "https://parcel.playereconlab.com")
		preflight.Header.Set("Access-Control-Request-Method", "PUT")
		preflight.Header.Set("Access-Control-Request-Headers", "content-type,x-amz-meta-parcel-upload")
		response, e := client.Do(preflight)
		if e != nil {
			t.Fatal("whole PUT preflight transport failed")
		}
		response.Body.Close()
		if (response.StatusCode != 200 && response.StatusCode != 204) || response.Header.Get("Access-Control-Allow-Origin") != "https://parcel.playereconlab.com" || !strings.Contains(strings.ToLower(response.Header.Get("Access-Control-Allow-Headers")), "x-amz-meta-parcel-upload") {
			t.Fatalf("whole PUT metadata CORS preflight rejected: status=%d origin=%q allowed_headers=%q", response.StatusCode, response.Header.Get("Access-Control-Allow-Origin"), response.Header.Get("Access-Control-Allow-Headers"))
		}
		put := func(payload []byte) {
			req, _ := http.NewRequestWithContext(ctx, "PUT", address, bytes.NewReader(payload))
			req.Header.Set("Content-Type", "application/octet-stream")
			req.Header.Set("Origin", "https://parcel.playereconlab.com")
			for k, v := range headers {
				req.Header.Set(k, v)
			}
			res, e := client.Do(req)
			if e != nil {
				t.Fatal("whole PUT transport failed")
			}
			res.Body.Close()
			if res.StatusCode != 200 {
				t.Fatalf("whole PUT status %d", res.StatusCode)
			}
			if res.Header.Get("Access-Control-Allow-Origin") != "https://parcel.playereconlab.com" {
				t.Fatal("PUT CORS missing")
			}
		}
		put(body)
		o, e := c.Head(ctx, stage)
		if e != nil || o.Size != int64(len(body)) || o.UploadID != "put-probe" {
			t.Fatal("whole PUT metadata/size verification failed")
		}
		if e = c.Copy(ctx, stage, key, "wrong-etag"); e == nil {
			t.Fatal("conditional copy accepted stale source")
		}
		if e = c.Copy(ctx, stage, key, o.ETag); e != nil {
			t.Fatal(e)
		}
		copied, e := c.Head(ctx, key)
		if e != nil || copied.Size != o.Size || copied.UploadID != o.UploadID {
			t.Fatal("R2 copy verification failed")
		}
		if len(body) > 0 {
			put(bytes.Repeat([]byte{'z'}, len(body)))
			get, e := c.SignGet(ctx, key, "probe.bin")
			if e != nil {
				t.Fatal(e)
			}
			req, _ := http.NewRequestWithContext(ctx, "GET", get, nil)
			res, e := client.Do(req)
			if e != nil {
				t.Fatal("GET transport failed")
			}
			b, _ := io.ReadAll(res.Body)
			res.Body.Close()
			if !bytes.Equal(b, body) {
				t.Fatal("reused staging PUT changed published object")
			}
		}
		_ = c.Delete(ctx, stage)
		_ = c.Delete(ctx, key)
	}
	t.Log("verified whole PUT (including zero-byte), task metadata, conditional in-R2 copy, CORS and immutability after staging URL reuse")
}
