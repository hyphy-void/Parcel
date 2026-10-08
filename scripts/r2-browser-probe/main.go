// r2-browser-probe prepares private presigned URLs for opt-in browser tests.
// It only creates or deletes generated parcel/probe/browser-* objects.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/hyphy-void/Parcel/internal/r2"
)

type probe struct {
	Size    int64             `json:"size"`
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers"`
	Key     string            `json:"key"`
	ID      string            `json:"id"`
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() error {
	action := flag.String("action", "init", "init, verify, or cleanup")
	credentials := flag.String("credentials", ".parcel-secrets/r2.credentials", "private credentials file")
	manifest := flag.String("manifest", ".parcel-secrets/browser-probe.json", "private output manifest")
	size := flag.Int64("size", 20<<20, "nonempty probe size, at most 100,000,000 bytes")
	flag.Parse()
	if *size < 1 || *size > 100_000_000 {
		return fmt.Errorf("invalid probe size")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	endpoint, bucket := os.Getenv("PARCEL_R2_LIVE_ENDPOINT"), os.Getenv("PARCEL_R2_LIVE_BUCKET")
	if endpoint == "" || bucket == "" {
		return fmt.Errorf("PARCEL_R2_LIVE_ENDPOINT and PARCEL_R2_LIVE_BUCKET are required")
	}
	c, err := r2.New(endpoint, bucket, *credentials)
	if err != nil {
		return fmt.Errorf("cannot initialize private R2 probe client")
	}
	var probes []probe
	switch *action {
	case "init":
		parent := filepath.Dir(*manifest)
		if err = os.MkdirAll(parent, 0700); err != nil {
			return fmt.Errorf("cannot create private manifest directory")
		}
		st, err := os.Stat(parent)
		if err != nil || st.Mode().Perm()&0077 != 0 {
			return fmt.Errorf("manifest directory must be private (0700)")
		}
		if st, err = os.Lstat(*manifest); err == nil && (st.Mode()&os.ModeSymlink != 0 || st.Mode().Perm()&0077 != 0) {
			return fmt.Errorf("existing manifest must be a private regular file")
		}
		for i, n := range []int64{0, *size} {
			id := fmt.Sprintf("browser-probe-%d-%d", time.Now().UnixNano(), i)
			p := probe{Size: n, Key: "parcel/probe/" + id, ID: id}
			p.URL, p.Headers, err = c.SignPut(ctx, p.Key, p.ID, p.Size)
			if err != nil {
				return fmt.Errorf("cannot sign probe PUT")
			}
			probes = append(probes, p)
		}
		b, _ := json.Marshal(probes)
		if err = os.WriteFile(*manifest, b, 0600); err != nil {
			return fmt.Errorf("cannot write private manifest")
		}
		fmt.Println("Private probe manifest prepared; URLs are not logged.")
	case "verify", "cleanup":
		st, err := os.Lstat(*manifest)
		if err != nil || !st.Mode().IsRegular() || st.Mode().Perm()&0077 != 0 {
			return fmt.Errorf("manifest must be a private regular file")
		}
		b, err := os.ReadFile(*manifest)
		if err != nil || json.Unmarshal(b, &probes) != nil {
			return fmt.Errorf("cannot read probe manifest")
		}
		for _, p := range probes {
			if !strings.HasPrefix(p.Key, "parcel/probe/browser-probe-") {
				return fmt.Errorf("manifest contains a key outside probe scope")
			}
			if *action == "cleanup" {
				if c.Delete(ctx, p.Key) != nil {
					return fmt.Errorf("probe deletion failed")
				}
			} else {
				o, err := c.Head(ctx, p.Key)
				if err != nil || o.Size != p.Size || o.UploadID != p.ID {
					return fmt.Errorf("probe size or metadata verification failed")
				}
				fmt.Printf("Verified browser PUT: %d bytes, matching task metadata.\n", p.Size)
			}
		}
		if *action == "cleanup" {
			fmt.Println("Generated browser probe objects deleted.")
		}
	default:
		return fmt.Errorf("unknown probe action")
	}
	return nil
}
