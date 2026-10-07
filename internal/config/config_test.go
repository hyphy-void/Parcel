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
