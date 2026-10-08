package parcel

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/hyphy-void/Parcel/internal/config"
	"github.com/hyphy-void/Parcel/internal/r2"
	"golang.org/x/sys/unix"
	_ "modernc.org/sqlite"
)

//go:embed migrations/*.sql
var migrations embed.FS

type stream struct {
	cancel    context.CancelFunc
	interrupt func()
}
type uploadLock struct {
	mu   sync.Mutex
	refs int
}
type limitEntry struct {
	count int
	until time.Time
}
type App struct {
	C             config.Config
	r2            r2.Store
	db            *sql.DB
	root          *os.Root
	lock          *os.File
	log           *slog.Logger
	mu            sync.Mutex
	cleanupMu     sync.Mutex
	uploadLocks   map[string]*uploadLock
	busyUploads   map[string]int
	finalizing    map[string]bool
	uploadCancel  map[string]context.CancelFunc
	streams       map[string]map[string]stream
	limits        map[string]limitEntry
	hashSlots     chan struct{}
	uploadSlots   chan struct{}
	finalizeSlots chan struct{}
	ctx           context.Context
	cancel        context.CancelFunc
	wg            sync.WaitGroup
	now           func() time.Time
	freeBytes     func() (int64, error)
	device        uint64
	static        fs.FS
}

func New(c config.Config, static fs.FS, logger *slog.Logger) (*App, error) {
	if e := c.Validate(); e != nil {
		return nil, e
	}
	if logger == nil {
		logger = slog.Default()
	}
	if e := checkMount(c); e != nil {
		return nil, e
	}
	if e := os.MkdirAll(c.DataDir, 0700); e != nil {
		return nil, e
	}
	lock, e := os.OpenFile(filepath.Join(c.DataDir, ".lock"), os.O_CREATE|os.O_RDWR|unix.O_NOFOLLOW, 0600)
	if e != nil {
		return nil, e
	}
	if e = unix.Flock(int(lock.Fd()), unix.LOCK_EX|unix.LOCK_NB); e != nil {
		lock.Close()
		return nil, fmt.Errorf("数据目录已被其他 Parcel 实例使用: %w", e)
	}
	root, e := os.OpenRoot(c.DataDir)
	if e != nil {
		lock.Close()
		return nil, e
	}
	for _, d := range []string{"tmp", "files"} {
		if e = root.Mkdir(d, 0700); e != nil && !errors.Is(e, os.ErrExist) {
			root.Close()
			lock.Close()
			return nil, e
		}
		fi, err := root.Lstat(d)
		if err != nil || !fi.IsDir() || fi.Mode()&os.ModeSymlink != 0 {
			root.Close()
			lock.Close()
			return nil, fmt.Errorf("存储子目录必须是真实目录: %s", d)
		}
	}
	for _, n := range []string{"parcel.db", "parcel.db-wal", "parcel.db-shm"} {
		fi, err := root.Lstat(n)
		if err == nil && (!fi.Mode().IsRegular() || fi.Mode()&os.ModeSymlink != 0) {
			root.Close()
			lock.Close()
			return nil, fmt.Errorf("不安全的数据库路径")
		}
	}
	db, e := sql.Open("sqlite", filepath.Join(c.DataDir, "parcel.db"))
	if e != nil {
		root.Close()
		lock.Close()
		return nil, e
	}
	db.SetMaxOpenConns(1)
	fail := func(err error) (*App, error) { db.Close(); root.Close(); lock.Close(); return nil, err }
	var store r2.Store
	if c.StorageBackend == "r2" {
		store, e = r2.New(c.R2Endpoint, c.R2Bucket, c.R2CredentialsFile)
		if e != nil {
			return fail(e)
		}
	}
	for _, q := range []string{"PRAGMA journal_mode=WAL", "PRAGMA foreign_keys=ON", "PRAGMA busy_timeout=5000", "PRAGMA synchronous=FULL"} {
		if _, e = db.Exec(q); e != nil {
			return fail(e)
		}
	}
	var exists int
	e = db.QueryRow("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='schema_migrations'").Scan(&exists)
	if e != nil {
		return fail(e)
	}
	if exists == 0 {
		schema, _ := migrations.ReadFile("migrations/001.sql")
		tx, err := db.Begin()
		if err != nil {
			return fail(err)
		}
		if _, err = tx.Exec(string(schema)); err != nil {
			tx.Rollback()
			return fail(err)
		}
		if err = tx.Commit(); err != nil {
			return fail(err)
		}
	}
	var version int
	if e = db.QueryRow("SELECT max(version) FROM schema_migrations").Scan(&version); e != nil || version < 1 || version > 3 {
		return fail(fmt.Errorf("不支持的数据库 schema 版本 %d", version))
	}
	for next := version + 1; next <= 3; next++ {
		schema, err := migrations.ReadFile(fmt.Sprintf("migrations/%03d.sql", next))
		if err != nil {
			return fail(err)
		}
		tx, err := db.Begin()
		if err != nil {
			return fail(err)
		}
		if _, err = tx.Exec(string(schema)); err != nil {
			tx.Rollback()
			return fail(err)
		}
		if err = tx.Commit(); err != nil {
			return fail(err)
		}
	}
	var remote int
	if e = db.QueryRow("SELECT (SELECT count(*) FROM shares WHERE backend='r2' AND state!='deleted') + (SELECT count(*) FROM uploads WHERE backend='r2' AND (state NOT IN ('completed','cleaned') OR (state='completed' AND part_bytes=0 AND staging_cleaned=0)))").Scan(&remote); e != nil {
		return fail(e)
	}
	if remote > 0 && store == nil {
		return fail(fmt.Errorf("存在 R2 数据，必须保留 R2 配置"))
	}
	ctx, cancel := context.WithCancel(context.Background())
	a := &App{C: c, r2: store, db: db, root: root, lock: lock, log: logger, uploadLocks: map[string]*uploadLock{}, busyUploads: map[string]int{}, finalizing: map[string]bool{}, uploadCancel: map[string]context.CancelFunc{}, streams: map[string]map[string]stream{}, limits: map[string]limitEntry{}, hashSlots: make(chan struct{}, 2), uploadSlots: make(chan struct{}, 2), finalizeSlots: make(chan struct{}, 1), ctx: ctx, cancel: cancel, now: time.Now, static: static}
	var st unix.Stat_t
	if e = unix.Stat(c.DataDir, &st); e != nil {
		cancel()
		return fail(e)
	}
	a.device = uint64(st.Dev)
	a.freeBytes = func() (int64, error) {
		var s unix.Statfs_t
		e := unix.Statfs(c.DataDir, &s)
		return int64(s.Bavail) * int64(s.Bsize), e
	}
	if e = a.recover(); e != nil {
		cancel()
		return fail(e)
	}
	return a, nil
}

func checkMount(c config.Config) error {
	if c.RequiredMount == "" {
		return nil
	}
	mount, e := filepath.EvalSymlinks(c.RequiredMount)
	if e != nil {
		return fmt.Errorf("SSD 挂载不存在: %w", e)
	}
	b, e := os.ReadFile("/proc/self/mountinfo")
	if e != nil {
		return e
	}
	found := false
	for _, line := range strings.Split(string(b), "\n") {
		p := strings.Fields(line)
		if len(p) > 4 {
			v := strings.NewReplacer("\\040", " ", "\\011", "\t", "\\134", "\\").Replace(p[4])
			if v == mount {
				found = true
				break
			}
		}
	}
	if !found {
		return fmt.Errorf("%s 不是已挂载的文件系统，拒绝写入", mount)
	}
	// Check the nearest existing ancestor, before creating any directories.
	parent := c.DataDir
	for {
		_, e = os.Stat(parent)
		if e == nil {
			break
		}
		if !errors.Is(e, os.ErrNotExist) {
			return e
		}
		next := filepath.Dir(parent)
		if next == parent {
			return e
		}
		parent = next
	}
	var target, source unix.Stat_t
	if e = unix.Stat(parent, &target); e != nil {
		return e
	}
	if e = unix.Stat(mount, &source); e != nil {
		return e
	}
	if target.Dev != source.Dev {
		return fmt.Errorf("DATA_DIR 不位于 REQUIRED_MOUNT 文件系统上")
	}
	return nil
}
func (a *App) diskReady() error {
	if e := checkMount(a.C); e != nil {
		return e
	}
	var st unix.Stat_t
	if e := unix.Stat(a.C.DataDir, &st); e != nil {
		return e
	}
	if uint64(st.Dev) != a.device {
		return fmt.Errorf("数据目录挂载发生变化")
	}
	return a.db.Ping()
}
func (a *App) Start() {
	a.wg.Add(1)
	go func() {
		defer a.wg.Done()
		t := time.NewTicker(a.C.CleanupInterval)
		defer t.Stop()
		for {
			select {
			case <-a.ctx.Done():
				return
			case <-t.C:
				a.Cleanup()
			}
		}
	}()
	a.mu.Lock()
	rows, e := a.db.Query("SELECT id FROM uploads WHERE state='finalizing'")
	var ids []string
	if e == nil {
		for rows.Next() {
			var id string
			rows.Scan(&id)
			ids = append(ids, id)
		}
		rows.Close()
	}
	a.mu.Unlock()
	for _, id := range ids {
		a.startFinalize(id)
	}
}
func (a *App) Close() error {
	a.cancel()
	a.mu.Lock()
	for _, group := range a.streams {
		for _, s := range group {
			s.cancel()
			s.interrupt()
		}
	}
	a.mu.Unlock()
	a.wg.Wait()
	_, _ = a.db.Exec("PRAGMA wal_checkpoint(TRUNCATE)")
	e := a.db.Close()
	a.root.Close()
	unix.Flock(int(a.lock.Fd()), unix.LOCK_UN)
	a.lock.Close()
	return e
}
func (a *App) InitAdmin(password string) error {
	hash, e := HashPassword(password)
	if e != nil {
		return e
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	tx, e := a.db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if _, e = tx.Exec("INSERT INTO admin_credentials(id,password_hash) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET password_hash=excluded.password_hash,version=version+1", hash); e != nil {
		return e
	}
	if _, e = tx.Exec("DELETE FROM admin_sessions"); e != nil {
		return e
	}
	return tx.Commit()
}
func (a *App) AdminExists() bool {
	var n int
	return a.db.QueryRow("SELECT count(*) FROM admin_credentials").Scan(&n) == nil && n == 1
}
func (a *App) audit(action, target, result string) {
	if _, e := a.db.Exec("INSERT INTO audit_events(action,target,result,created) VALUES(?,?,?,?)", action, target, result, a.now().Unix()); e != nil {
		a.log.Error("audit failed", "error", e)
	}
}
func (a *App) getUploadLock(id string) func() {
	a.mu.Lock()
	l := a.uploadLocks[id]
	if l == nil {
		l = &uploadLock{}
		a.uploadLocks[id] = l
	}
	l.refs++
	a.mu.Unlock()
	l.mu.Lock()
	return func() {
		l.mu.Unlock()
		a.mu.Lock()
		l.refs--
		if l.refs == 0 {
			delete(a.uploadLocks, id)
		}
		a.mu.Unlock()
	}
}
