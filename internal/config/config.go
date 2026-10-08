package config

import (
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Listen, BaseURL, DataDir, RequiredMount, LogLevel                            string
	R2Quota, MaxFile, Quota, MinFree, Chunk                                      int64
	UploadTTL, ShareTTL, MaxShareTTL, DownloadIdle, DownloadMax, CleanupInterval time.Duration
	DownloadLimit                                                                int
	// TrustedProxies is opt-in. Only these immediate peers may supply client IPs
	// via X-Forwarded-For; it does not authorize administrative access.
	TrustedProxies                                          []netip.Prefix
	StorageBackend, R2Endpoint, R2Bucket, R2CredentialsFile string
}

func Load() (Config, error) {
	c := Config{R2Quota: 9_000_000_000, StorageBackend: "local", Listen: "127.0.0.1:8080", BaseURL: "http://127.0.0.1:8080", DataDir: "./data", LogLevel: "info", MaxFile: 8 << 30, Quota: 20 << 30, MinFree: 2 << 30, Chunk: 8 << 20, UploadTTL: 24 * time.Hour, ShareTTL: 24 * time.Hour, MaxShareTTL: 7 * 24 * time.Hour, DownloadIdle: 30 * time.Minute, DownloadMax: 8 * time.Hour, CleanupInterval: time.Minute, DownloadLimit: 3}
	for k, p := range map[string]*string{"LISTEN_ADDR": &c.Listen, "BASE_URL": &c.BaseURL, "DATA_DIR": &c.DataDir, "REQUIRED_MOUNT": &c.RequiredMount, "LOG_LEVEL": &c.LogLevel, "STORAGE_BACKEND": &c.StorageBackend, "R2_ENDPOINT": &c.R2Endpoint, "R2_BUCKET": &c.R2Bucket, "R2_CREDENTIALS_FILE": &c.R2CredentialsFile} {
		if v, ok := os.LookupEnv("PARCEL_" + k); ok {
			*p = v
		}
	}
	for k, p := range map[string]*int64{"R2_STORAGE_QUOTA_BYTES": &c.R2Quota, "MAX_FILE_BYTES": &c.MaxFile, "STORAGE_QUOTA_BYTES": &c.Quota, "MIN_FREE_BYTES": &c.MinFree, "UPLOAD_CHUNK_BYTES": &c.Chunk} {
		if v, ok := os.LookupEnv("PARCEL_" + k); ok {
			n, e := strconv.ParseInt(v, 10, 64)
			if e != nil {
				return c, fmt.Errorf("PARCEL_%s: %w", k, e)
			}
			*p = n
		}
	}
	for k, p := range map[string]*time.Duration{"UPLOAD_IDLE_TTL": &c.UploadTTL, "DEFAULT_SHARE_TTL": &c.ShareTTL, "MAX_SHARE_TTL": &c.MaxShareTTL, "DOWNLOAD_IDLE_TTL": &c.DownloadIdle, "DOWNLOAD_MAX_TTL": &c.DownloadMax, "CLEANUP_INTERVAL": &c.CleanupInterval} {
		if v, ok := os.LookupEnv("PARCEL_" + k); ok {
			n, e := time.ParseDuration(v)
			if e != nil {
				return c, fmt.Errorf("PARCEL_%s: %w", k, e)
			}
			*p = n
		}
	}
	if v, ok := os.LookupEnv("PARCEL_DEFAULT_DOWNLOAD_LIMIT"); ok {
		n, e := strconv.Atoi(v)
		if e != nil {
			return c, e
		}
		c.DownloadLimit = n
	}
	d, e := filepath.Abs(c.DataDir)
	if e != nil {
		return c, e
	}
	c.DataDir = d
	if raw := os.Getenv("PARCEL_TRUSTED_PROXIES"); strings.TrimSpace(raw) != "" {
		for _, entry := range strings.Split(raw, ",") {
			prefix, err := netip.ParsePrefix(strings.TrimSpace(entry))
			if err != nil {
				return c, fmt.Errorf("PARCEL_TRUSTED_PROXIES: %w", err)
			}
			c.TrustedProxies = append(c.TrustedProxies, prefix.Masked())
		}
	}
	return c, c.Validate()
}

func (c Config) Validate() error {
	if c.StorageBackend != "" && c.StorageBackend != "local" && c.StorageBackend != "r2" {
		return fmt.Errorf("STORAGE_BACKEND 必须是 local 或 r2")
	}
	if c.StorageBackend == "r2" {
		if c.R2Quota <= 0 {
			return fmt.Errorf("R2_STORAGE_QUOTA_BYTES 必须大于零")
		}
		u, err := url.Parse(c.R2Endpoint)
		if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || !strings.HasSuffix(u.Hostname(), ".r2.cloudflarestorage.com") || u.Port() != "" {
			return fmt.Errorf("R2_ENDPOINT 必须是 R2 S3 HTTPS origin，不含桶名")
		}
		if c.MaxFile > (16<<20)*10000 {
			return fmt.Errorf("R2 文件上限不能超过 10,000 个 16 MiB 分块")
		}
		if c.R2Bucket == "" || strings.ContainsAny(c.R2Bucket, "/ \\?\n") || c.R2CredentialsFile == "" {
			return fmt.Errorf("R2_BUCKET 和 R2_CREDENTIALS_FILE 必须配置")
		}
	}

	for _, prefix := range c.TrustedProxies {
		if !prefix.IsValid() || prefix.Bits() == 0 || prefix.Addr().Is4In6() {
			return fmt.Errorf("TRUSTED_PROXIES 必须是有效的 IPv4/IPv6 CIDR，不能信任所有地址或使用映射 IPv4")
		}
	}
	host, _, e := net.SplitHostPort(c.Listen)
	if e != nil {
		return fmt.Errorf("LISTEN_ADDR: %w", e)
	}
	ip := net.ParseIP(host)
	if ip == nil || ip.IsUnspecified() || !(ip.IsLoopback() || ip.IsPrivate()) {
		return fmt.Errorf("LISTEN_ADDR 必须绑定明确的回环或内网 IP")
	}
	u, e := url.Parse(c.BaseURL)
	if e != nil || u == nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return fmt.Errorf("BASE_URL 必须是无路径、无凭证的 http(s) origin")
	}
	if strings.TrimSuffix(c.BaseURL, "/") != c.BaseURL {
		return fmt.Errorf("BASE_URL 不应以 / 结尾")
	}
	if c.MaxFile <= 0 || c.Quota < c.MaxFile || c.MinFree < 0 || c.Chunk <= 0 || c.Chunk > 64<<20 || c.Chunk > c.MaxFile {
		return fmt.Errorf("文件上限、配额或分块配置不合法")
	}
	if c.ShareTTL < time.Second || c.MaxShareTTL < c.ShareTTL || c.UploadTTL < time.Second || c.DownloadIdle < time.Second || c.DownloadMax < c.DownloadIdle || c.CleanupInterval <= 0 || c.DownloadLimit < 1 || c.DownloadLimit > 100 {
		return fmt.Errorf("有效期或下载次数配置不合法")
	}
	return nil
}
