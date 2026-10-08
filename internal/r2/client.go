// Package r2 implements the private R2 S3 control plane. File bytes use signed URLs.
package r2

import (
	"context"
	"errors"
	"fmt"
	"mime"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/smithy-go"
)

const PartSize int64 = 16 << 20
const URLTTL = 5 * time.Minute

var ErrNotFound = errors.New("R2 resource not found")

type Part struct {
	Number int32  `json:"number"`
	Size   int64  `json:"size"`
	ETag   string `json:"etag"`
}
type Object struct {
	Size           int64
	UploadID, ETag string
}
type Store interface {
	SignPut(context.Context, string, string, int64) (string, map[string]string, error)
	Copy(context.Context, string, string, string) error
	Create(context.Context, string, string) (string, error)
	Parts(context.Context, string, string) ([]Part, error)
	SignPart(context.Context, string, string, int32, int64) (string, error)
	Complete(context.Context, string, string, []Part) error
	Head(context.Context, string) (Object, error)
	Abort(context.Context, string, string) error
	Delete(context.Context, string) error
	SignGet(context.Context, string, string) (string, error)
}
type Client struct {
	S3     *s3.Client
	signer *s3.PresignClient
	bucket string
}

// Credentials reads either Access Key ID / Secret Access Key labels (same or next
// line), or ACCESS_KEY_ID= / SECRET_ACCESS_KEY=. Never include file contents in errors.
func Credentials(path string) (string, string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", "", errors.New("无法读取 R2 凭据文件")
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() || st.Mode().Perm()&0077 != 0 || st.Size() > 16384 {
		return "", "", errors.New("R2 凭据文件必须是权限 0600 的小型普通文件")
	}
	b := make([]byte, st.Size())
	if _, err = f.ReadAt(b, 0); err != nil {
		return "", "", errors.New("无法读取 R2 凭据文件")
	}
	var key, secret, pending string
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		label := ""
		value := ""
		for _, field := range []string{"Access Key ID", "Secret Access Key", "ACCESS_KEY_ID", "SECRET_ACCESS_KEY"} {
			if strings.HasPrefix(line, field) {
				label = field
				value = strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(strings.TrimPrefix(line, field)), ":：="))
				break
			}
		}
		if label != "" {
			pending = label
			if value == "" {
				continue
			}
		} else if pending != "" {
			value = line
		} else {
			continue
		}
		if pending == "Access Key ID" || pending == "ACCESS_KEY_ID" {
			key = value
		} else {
			secret = value
		}
		pending = ""
	}
	if key == "" || secret == "" || strings.ContainsAny(key+secret, " \t\r\n") {
		return "", "", errors.New("R2 凭据文件缺少有效字段")
	}
	return key, secret, nil
}
func New(endpoint, bucket, path string) (*Client, error) {
	key, secret, err := Credentials(path)
	if err != nil {
		return nil, err
	}
	c := s3.New(s3.Options{Region: "auto", BaseEndpoint: aws.String(endpoint), UsePathStyle: true, Credentials: credentials.NewStaticCredentialsProvider(key, secret, ""), HTTPClient: &http.Client{Timeout: 30 * time.Second}, RetryMaxAttempts: 2, RequestChecksumCalculation: aws.RequestChecksumCalculationWhenRequired, ResponseChecksumValidation: aws.ResponseChecksumValidationWhenRequired})
	return &Client{S3: c, signer: s3.NewPresignClient(c), bucket: bucket}, nil
}

// SDK errors can contain signed URLs. Return only an API code, never the raw error.
func safe(err error) error {
	if err == nil {
		return nil
	}
	var api smithy.APIError
	if errors.As(err, &api) {
		switch api.ErrorCode() {
		case "NoSuchKey", "NotFound", "NoSuchUpload":
			return ErrNotFound
		}
		return fmt.Errorf("R2 API: %s", api.ErrorCode())
	}
	return errors.New("R2 请求失败或超时")
}
func (c *Client) Create(ctx context.Context, key, id string) (string, error) {
	v, e := c.S3.CreateMultipartUpload(ctx, &s3.CreateMultipartUploadInput{Bucket: &c.bucket, Key: &key, ContentType: aws.String("application/octet-stream"), Metadata: map[string]string{"parcel-upload": id}})
	if e != nil {
		return "", safe(e)
	}
	return aws.ToString(v.UploadId), nil
}
func (c *Client) Parts(ctx context.Context, key, id string) ([]Part, error) {
	parts := []Part{}
	p := s3.NewListPartsPaginator(c.S3, &s3.ListPartsInput{Bucket: &c.bucket, Key: &key, UploadId: &id})
	for p.HasMorePages() {
		v, e := p.NextPage(ctx)
		if e != nil {
			return nil, safe(e)
		}
		for _, x := range v.Parts {
			parts = append(parts, Part{aws.ToInt32(x.PartNumber), aws.ToInt64(x.Size), aws.ToString(x.ETag)})
		}
	}
	return parts, nil
}
func (c *Client) SignPart(ctx context.Context, key, id string, n int32, size int64) (string, error) {
	v, e := c.signer.PresignUploadPart(ctx, &s3.UploadPartInput{Bucket: &c.bucket, Key: &key, UploadId: &id, PartNumber: &n, ContentLength: &size}, func(o *s3.PresignOptions) { o.Expires = URLTTL })
	if e != nil {
		return "", safe(e)
	}
	return v.URL, nil
}
func (c *Client) Complete(ctx context.Context, key, id string, parts []Part) error {
	p := []types.CompletedPart{}
	for _, x := range parts {
		p = append(p, types.CompletedPart{PartNumber: aws.Int32(x.Number), ETag: aws.String(x.ETag)})
	}
	_, e := c.S3.CompleteMultipartUpload(ctx, &s3.CompleteMultipartUploadInput{Bucket: &c.bucket, Key: &key, UploadId: &id, MultipartUpload: &types.CompletedMultipartUpload{Parts: p}})
	return safe(e)
}
func (c *Client) Head(ctx context.Context, key string) (Object, error) {
	v, e := c.S3.HeadObject(ctx, &s3.HeadObjectInput{Bucket: &c.bucket, Key: &key})
	if e != nil {
		return Object{}, safe(e)
	}
	return Object{aws.ToInt64(v.ContentLength), v.Metadata["parcel-upload"], aws.ToString(v.ETag)}, nil
}
func (c *Client) Abort(ctx context.Context, key, id string) error {
	if id == "" {
		return nil
	}
	_, e := c.S3.AbortMultipartUpload(ctx, &s3.AbortMultipartUploadInput{Bucket: &c.bucket, Key: &key, UploadId: &id})
	e = safe(e)
	if errors.Is(e, ErrNotFound) {
		return nil
	}
	return e
}
func (c *Client) Delete(ctx context.Context, key string) error {
	_, e := c.S3.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: &c.bucket, Key: &key})
	return safe(e)
}
func (c *Client) SignGet(ctx context.Context, key, name string) (string, error) {
	disposition := mime.FormatMediaType("attachment", map[string]string{"filename": name})
	v, e := c.signer.PresignGetObject(ctx, &s3.GetObjectInput{Bucket: &c.bucket, Key: &key, ResponseContentDisposition: &disposition, ResponseContentType: aws.String("application/octet-stream"), ResponseCacheControl: aws.String("private, no-store")}, func(o *s3.PresignOptions) { o.Expires = URLTTL })
	if e != nil {
		return "", safe(e)
	}
	return v.URL, nil
}

// Signed metadata binds a whole-object PUT to its server-created upload task.
func (c *Client) SignPut(ctx context.Context, key, id string, size int64) (string, map[string]string, error) {
	v, err := c.signer.PresignPutObject(ctx, &s3.PutObjectInput{
		Bucket: &c.bucket, Key: &key, ContentLength: &size,
		ContentType: aws.String("application/octet-stream"), Metadata: map[string]string{"parcel-upload": id},
	}, func(o *s3.PresignOptions) { o.Expires = URLTTL })
	if err != nil {
		return "", nil, safe(err)
	}
	headers := map[string]string{}
	for name, values := range v.SignedHeader {
		if strings.EqualFold(name, "host") || strings.EqualFold(name, "content-length") {
			continue
		}
		headers[name] = strings.Join(values, ",")
	}
	return v.URL, headers, nil
}

// Copy runs entirely inside R2. Match the verified source version so an upload
// URL reused concurrently cannot replace the object admitted for publication.
func (c *Client) Copy(ctx context.Context, source, target, etag string) error {
	copySource := url.PathEscape(c.bucket + "/" + source)
	_, err := c.S3.CopyObject(ctx, &s3.CopyObjectInput{
		Bucket: &c.bucket, Key: &target, CopySource: &copySource,
		CopySourceIfMatch: &etag, MetadataDirective: types.MetadataDirectiveCopy,
	})
	return safe(err)
}
