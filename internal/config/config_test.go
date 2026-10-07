package config

import "testing"

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
