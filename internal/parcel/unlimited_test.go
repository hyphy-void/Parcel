package parcel

import (
	"database/sql"
	"net/http"
	"testing"
	"time"
)

func TestUnlimitedDownloads(t *testing.T) {
	for _, backend := range []string{"local", "r2"} {
		t.Run(backend, func(t *testing.T) {
			f := testApp(t)
			var share Share
			if backend == "r2" {
				share = r2Publish(t, f, useR2(f), -1)
				hash, err := hashSharePassword("unlimited-password")
				if err != nil {
					t.Fatal(err)
				}
				if _, err = f.a.db.Exec("UPDATE shares SET password_hash=? WHERE id=?", hash, share.ID); err != nil {
					t.Fatal(err)
				}
			} else {
				share = f.publish(t, []byte("unlimited"), "unlimited-password", -1)
			}
			path := "/api/v1/shares/" + share.ID
			if w := f.request("POST", path+"/download-sessions", nil, nil, false); w.Code != 401 {
				t.Fatalf("password bypass: %d", w.Code)
			}
			grant := f.request("POST", path+"/unlock", map[string]any{"password": "unlimited-password"}, nil, false).Result().Cookies()[0]
			if _, err := f.a.db.Exec("UPDATE shares SET download_count=99 WHERE id=?", share.ID); err != nil {
				t.Fatal(err)
			}
			for range 4 {
				ticket := f.ticket(t, share.ID, grant)
				if backend == "local" {
					if w := f.request("GET", ticket, nil, nil, false); w.Code != http.StatusOK {
						t.Fatalf("download %d: %s", w.Code, w.Body.String())
					}
				}
			}
			count(t, f.a, share.ID, 103)
			if _, err := f.a.db.Exec("DELETE FROM download_sessions; UPDATE shares SET signed_until=0 WHERE id=?", share.ID); err != nil {
				t.Fatal(err)
			}
			f.a.Cleanup()
			current, err := f.a.share(share.ID)
			if err != nil || current.Availability != "available" {
				t.Fatalf("unlimited share cleaned: %+v %v", current, err)
			}
			if _, err := f.a.db.Exec("UPDATE shares SET expires=? WHERE id=?", time.Now().Add(-time.Hour).Unix(), share.ID); err != nil {
				t.Fatal(err)
			}
			if w := f.request("POST", path+"/download-sessions", nil, map[string]string{"Cookie": grant.String()}, false); w.Code != 410 {
				t.Fatalf("expired share accepted: %d", w.Code)
			}
			f.a.Cleanup()
			current, err = f.a.share(share.ID)
			if err != nil || current.State != "deleted" {
				t.Fatalf("expired share not cleaned: %+v %v", current, err)
			}
		})
	}
}

func TestUnlimitedSchemaMigrationPreservesGrantsAndSessions(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err = db.Exec("PRAGMA foreign_keys=ON"); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"001", "002", "003"} {
		schema, _ := migrations.ReadFile("migrations/" + name + ".sql")
		if _, err = db.Exec(string(schema)); err != nil {
			t.Fatal(err)
		}
	}
	for _, query := range []string{
		"INSERT INTO uploads(id,name,size,ttl,max_downloads,state,storage_key,share_id,created,updated) VALUES('upload','file',7,3600,3,'completed','object','share',1,1)",
		"INSERT INTO shares(id,upload_id,storage_key,name,size,sha256,password_hash,created,expires,max_downloads,download_count,backend,etag,signed_until) VALUES('share','upload','object','file',7,'hash','password',1,3601,3,2,'r2','etag',500)",
		"INSERT INTO share_grants VALUES('grant','share',1,500)",
		"INSERT INTO download_sessions(token_hash,share_id,version,state,created,last_activity,expires) VALUES('session','share',1,'active',1,1,500)",
	} {
		if _, err = db.Exec(query); err != nil {
			t.Fatal(err)
		}
	}
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	schema, _ := migrations.ReadFile("migrations/004.sql")
	if _, err = tx.Exec(string(schema)); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	var grants, sessions, downloads int
	var password, backend, etag string
	var signed int64
	if err = db.QueryRow("SELECT (SELECT count(*) FROM share_grants),(SELECT count(*) FROM download_sessions),download_count,password_hash,backend,etag,signed_until FROM shares").Scan(&grants, &sessions, &downloads, &password, &backend, &etag, &signed); err != nil {
		t.Fatal(err)
	}
	if grants != 1 || sessions != 1 || downloads != 2 || password != "password" || backend != "r2" || etag != "etag" || signed != 500 {
		t.Fatal("migration lost authority")
	}
	if _, err = db.Exec("UPDATE shares SET max_downloads=-1,download_count=101"); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec("UPDATE shares SET max_downloads=3"); err == nil {
		t.Fatal("finite limit constraint lost")
	}
	if _, err = db.Exec("DELETE FROM shares"); err != nil {
		t.Fatal(err)
	}
	if err = db.QueryRow("SELECT (SELECT count(*) FROM share_grants)+(SELECT count(*) FROM download_sessions)").Scan(&grants); err != nil || grants != 0 {
		t.Fatal("foreign-key cascade lost")
	}
}
