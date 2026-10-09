package config

import (
	"net/netip"
	"testing"
)

func TestTrustedProxies(t *testing.T) {
	t.Setenv("PARCEL_TRUSTED_PROXIES", "127.0.0.1/32, ::1/128")
	c, err := Load()
	if err != nil || len(c.TrustedProxies) != 2 {
		t.Fatalf("load proxies: %+v %v", c.TrustedProxies, err)
	}
	for _, raw := range []string{"localhost", "127.0.0.1", "127.0.0.1/32,", "0.0.0.0/0", "::/0", "::ffff:127.0.0.1/128"} {
		t.Setenv("PARCEL_TRUSTED_PROXIES", raw)
		if _, err := Load(); err == nil {
			t.Fatalf("accepted %q", raw)
		}
	}
	t.Setenv("PARCEL_TRUSTED_PROXIES", "")
	c, err = Load()
	if err != nil || len(c.TrustedProxies) != 0 {
		t.Fatalf("default must trust no proxy: %v", err)
	}
	c.TrustedProxies = []netip.Prefix{{}}
	if c.Validate() == nil {
		t.Fatal("accepted invalid prefix")
	}
}

func TestConfigRejectsExposureAndInvalidLimits(t *testing.T) {
	c, e := Load()
	if e != nil {
		t.Fatal(e)
	}
	for _, addr := range []string{"0.0.0.0:8080", "[::]:8080", "example.com:8080", "8.8.8.8:8080"} {
		v := c
		v.Listen = addr
		if v.Validate() == nil {
			t.Fatal(addr)
		}
	}
	for _, base := range []string{"http://user:secret@localhost", "http://localhost/path", "http://localhost/?a=1", "ftp://localhost", "http://localhost/"} {
		v := c
		v.BaseURL = base
		if v.Validate() == nil {
			t.Fatal(base)
		}
	}
	v := c
	v.Quota = v.MaxFile - 1
	if v.Validate() == nil {
		t.Fatal("quota accepted")
	}
	v = c
	v.DownloadMax = v.DownloadIdle - 1
	if v.Validate() == nil {
		t.Fatal("TTL accepted")
	}
}

func TestR2Configuration(t *testing.T) {
	t.Setenv("PARCEL_STORAGE_BACKEND", "r2")
	t.Setenv("PARCEL_R2_ENDPOINT", "https://example.r2.cloudflarestorage.com")
	t.Setenv("PARCEL_R2_BUCKET", "parcel")
	t.Setenv("PARCEL_R2_CREDENTIALS_FILE", "/etc/parcel/r2.credentials")
	c, e := Load()
	if e != nil {
		t.Fatal(e)
	}
	for _, endpoint := range []string{"https://example.r2.cloudflarestorage.com/parcel", "https://example.r2.cloudflarestorage.com/", "http://example.r2.cloudflarestorage.com", "https://user:secret@example.r2.cloudflarestorage.com", "https://example.com", "https://example.r2.cloudflarestorage.com?key=value"} {
		v := c
		v.R2Endpoint = endpoint
		if v.Validate() == nil {
			t.Fatal("invalid R2 endpoint accepted")
		}
	}
	v := c
	v.R2CredentialsFile = ""
	if v.Validate() == nil {
		t.Fatal("missing credentials accepted")
	}
	v = c
	v.StorageBackend = "other"
	if v.Validate() == nil {
		t.Fatal("unknown backend accepted")
	}
}

func TestAccessRequiresProtectedR2Gateway(t *testing.T) {
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	c.AdminAuth = "access"
	if c.Validate() == nil {
		t.Fatal("Access accepted without gateway secret")
	}
	c.GatewaySecretFile = "/etc/parcel/gateway.secret"
	if c.Validate() == nil {
		t.Fatal("gateway accepted with local storage")
	}
	c.StorageBackend = "r2"
	c.R2Endpoint = "https://example.r2.cloudflarestorage.com"
	c.R2Bucket = "parcel"
	c.R2CredentialsFile = "/etc/parcel/r2.credentials"
	if c.Validate() == nil {
		t.Fatal("gateway accepted over HTTP")
	}
	c.BaseURL = "https://parcel.example.com"
	if err = c.Validate(); err != nil {
		t.Fatal(err)
	}
	c.AdminAuth = "typo"
	if c.Validate() == nil {
		t.Fatal("invalid auth mode accepted")
	}
}
