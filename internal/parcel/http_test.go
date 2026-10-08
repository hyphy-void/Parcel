package parcel

import (
	"bufio"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// Accelerate the handler's deadline while exercising a real connection/body.
// Without a deadline installed by Parcel this socket remains blocked.
type shortDeadlineWriter struct{ http.ResponseWriter }

func (w shortDeadlineWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w shortDeadlineWriter) SetReadDeadline(deadline time.Time) error {
	if !deadline.IsZero() {
		deadline = time.Now().Add(100 * time.Millisecond)
	}
	return http.NewResponseController(w.ResponseWriter).SetReadDeadline(deadline)
}

func TestSlowRequestBodiesAreBounded(t *testing.T) {
	f := testApp(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.h.ServeHTTP(shortDeadlineWriter{w}, r)
	}))
	defer server.Close()
	for _, tc := range []struct {
		name, path, origin string
		status             int
	}{
		{"login", "/api/v1/auth/login", f.a.C.BaseURL, http.StatusRequestTimeout},
		{"refresh", "/api/v1/shares/missing/download-sessions/refresh", f.a.C.BaseURL, http.StatusRequestTimeout},
		{"unauthenticated", "/api/v1/uploads", f.a.C.BaseURL, http.StatusUnauthorized},
		{"origin rejected", "/api/v1/auth/login", "http://evil.example", http.StatusForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			conn, err := net.Dial("tcp", server.Listener.Addr().String())
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			_ = conn.SetDeadline(time.Now().Add(time.Second))
			_, err = fmt.Fprintf(conn, "POST %s HTTP/1.1\r\nHost: 127.0.0.1:8080\r\nOrigin: %s\r\nContent-Length: 100\r\n\r\n{", tc.path, tc.origin)
			if err != nil {
				t.Fatal(err)
			}
			response, err := http.ReadResponse(bufio.NewReader(conn), nil)
			if err != nil {
				t.Fatalf("slow body was not bounded: %v", err)
			}
			defer response.Body.Close()
			if response.StatusCode != tc.status {
				t.Fatalf("status %d want %d", response.StatusCode, tc.status)
			}
		})
	}
}

func TestLocalUploadOpenFailureStillBoundsBodyDrain(t *testing.T) {
	f := testApp(t)
	u := f.create(t, 7, "", 1)
	// The storage root is ready, but opening this task's file fails before the
	// handler reads the body. net/http still drains that body after the reply.
	if err := f.a.root.Remove("tmp/" + u.ID + ".part"); err != nil {
		t.Fatal(err)
	}
	if err := f.a.root.Mkdir("tmp/"+u.ID+".part", 0700); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.h.ServeHTTP(shortDeadlineWriter{w}, r)
	}))
	defer server.Close()
	conn, err := net.Dial("tcp", server.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(time.Second))
	_, err = fmt.Fprintf(conn, "PATCH /api/v1/uploads/%s HTTP/1.1\r\nHost: 127.0.0.1:8080\r\nOrigin: %s\r\nCookie: %s=%s\r\nX-CSRF-Token: %s\r\nUpload-Offset: 0\r\nContent-Length: 7\r\n\r\nx", u.ID, f.a.C.BaseURL, f.cookie.Name, f.cookie.Value, f.csrf)
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatalf("open failure cleared body drain deadline: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusInternalServerError {
		t.Fatal(response.StatusCode)
	}
}
