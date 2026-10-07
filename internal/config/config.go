package config

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Listen, BaseURL, DataDir, RequiredMount, LogLevel                            string
	MaxFile, Quota, MinFree, Chunk                                               int64
	UploadTTL, ShareTTL, MaxShareTTL, DownloadIdle, DownloadMax, CleanupInterval time.Duration
	DownloadLimit                                                                int
}

func Load() (Config, error) {
	c := Config{Listen: "127.0.0.1:8080", BaseURL: "http://127.0.0.1:8080", DataDir: "./data", LogLevel: "info", MaxFile: 8 << 30, Quota: 20 << 30, MinFree: 2 << 30, Chunk: 8 << 20, UploadTTL: 24 * time.Hour, ShareTTL: 24 * time.Hour, MaxShareTTL: 7 * 24 * time.Hour, DownloadIdle: 30 * time.Minute, DownloadMax: 8 * time.Hour, CleanupInterval: time.Minute, DownloadLimit: 3}
	for k, p := range map[string]*string{"LISTEN_ADDR": &c.Listen, "BASE_URL": &c.BaseURL, "DATA_DIR": &c.DataDir, "REQUIRED_MOUNT": &c.RequiredMount, "LOG_LEVEL": &c.LogLevel} {
		if v, ok := os.LookupEnv("PARCEL_" + k); ok {
			*p = v
		}
	}
	for k, p := range map[string]*int64{"MAX_FILE_BYTES": &c.MaxFile, "STORAGE_QUOTA_BYTES": &c.Quota, "MIN_FREE_BYTES": &c.MinFree, "UPLOAD_CHUNK_BYTES": &c.Chunk} {
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
	return c, c.Validate()
}

func (c Config) Validate() error {
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
