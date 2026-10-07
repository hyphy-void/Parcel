package parcel

import (
	"database/sql"
	"errors"
)

type scanner interface{ Scan(...any) error }
type Upload struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Size         int64  `json:"size"`
	Offset       int64  `json:"offset"`
	TTL          int64  `json:"ttl_seconds"`
	MaxDownloads int    `json:"max_downloads"`
	PasswordHash string `json:"-"`
	State        string `json:"state"`
	StorageKey   string `json:"-"`
	ShareID      string `json:"share_id"`
	Created      int64  `json:"created"`
	Updated      int64  `json:"updated"`
	Error        string `json:"error"`
}

const uploadColumns = "id,name,size,offset,ttl,max_downloads,password_hash,state,storage_key,share_id,created,updated,error"

func scanUpload(s scanner) (u Upload, e error) {
	e = s.Scan(&u.ID, &u.Name, &u.Size, &u.Offset, &u.TTL, &u.MaxDownloads, &u.PasswordHash, &u.State, &u.StorageKey, &u.ShareID, &u.Created, &u.Updated, &u.Error)
	return
}
func (a *App) upload(id string) (Upload, error) {
	return scanUpload(a.db.QueryRow("SELECT "+uploadColumns+" FROM uploads WHERE id=?", id))
}

type Share struct {
	ID               string `json:"id"`
	UploadID         string `json:"upload_id"`
	StorageKey       string `json:"-"`
	Name             string `json:"name"`
	Size             int64  `json:"size"`
	SHA256           string `json:"sha256"`
	PasswordHash     string `json:"-"`
	Created          int64  `json:"created"`
	Expires          int64  `json:"expires"`
	MaxDownloads     int    `json:"max_downloads"`
	DownloadCount    int    `json:"download_count"`
	Version          int    `json:"-"`
	State            string `json:"state"`
	Error            string `json:"error"`
	PasswordRequired bool   `json:"password_required"`
	Availability     string `json:"availability"`
	URL              string `json:"url"`
}

const shareColumns = "id,upload_id,storage_key,name,size,sha256,password_hash,created,expires,max_downloads,download_count,version,state,error"

func scanShare(s scanner) (v Share, e error) {
	e = s.Scan(&v.ID, &v.UploadID, &v.StorageKey, &v.Name, &v.Size, &v.SHA256, &v.PasswordHash, &v.Created, &v.Expires, &v.MaxDownloads, &v.DownloadCount, &v.Version, &v.State, &v.Error)
	v.PasswordRequired = v.PasswordHash != ""
	return
}
func (a *App) share(id string) (Share, error) {
	v, e := scanShare(a.db.QueryRow("SELECT "+shareColumns+" FROM shares WHERE id=?", id))
	v.Availability = a.availability(v)
	v.URL = a.C.BaseURL + "/s/" + v.ID
	return v, e
}
func (a *App) availability(s Share) string {
	if s.State != "active" {
		return s.State
	}
	if a.now().Unix() >= s.Expires {
		return "expired"
	}
	if s.DownloadCount >= s.MaxDownloads {
		return "exhausted"
	}
	return "available"
}
func missing(e error) bool { return errors.Is(e, sql.ErrNoRows) }
