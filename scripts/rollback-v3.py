#!/usr/bin/env python3
"""Restore frozen D1 authority into Go SQLite, preserving Go administrator data."""
import argparse
import fcntl
import hashlib
import json
import os
import sqlite3
import time
from pathlib import Path

TABLES = ("uploads", "shares", "share_grants", "download_sessions")


def restore_database(snapshot_path, database_path, bucket):
    envelope = json.loads(Path(snapshot_path).read_text())
    payload = envelope.get("payload", "")
    if hashlib.sha256(payload.encode()).hexdigest() != envelope.get("sha256"):
        raise ValueError("Snapshot checksum mismatch")
    data = json.loads(payload)
    if data.get("source") != "d1-v3" or data.get("format") != 1 or data.get("bucket") != bucket:
        raise ValueError("Snapshot does not match V3 source/bucket")
    if any(u["state"] not in ("completed", "cleaned") for u in data["rows"]["uploads"]):
        raise ValueError("Finish or cancel all V3 uploads first")
    if any(row.get("password_hash", "").startswith("$parcel-") for table in ("uploads", "shares") for row in data["rows"][table]):
        raise ValueError("Export with the V3 SESSION_SECRET to restore Go-compatible password hashes first")
    database_path = Path(database_path).resolve()
    if not database_path.is_file():
        raise ValueError("Existing Go database is required to preserve administrator configuration")
    lock_fd = os.open(database_path.parent / ".lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        db = sqlite3.connect(database_path)
        db.execute("PRAGMA foreign_keys=ON")
        if db.execute("SELECT max(version) FROM schema_migrations").fetchone()[0] != 3:
            raise ValueError("Go target must use schema 3")
        if db.execute("SELECT count(*) FROM shares WHERE backend!='r2'").fetchone()[0]:
            raise ValueError("Go target has local shares; do not discard another authority")
        backup_path = database_path.with_name(f"{database_path.name}.before-v3-rollback-{time.time_ns()}")
        fd = os.open(backup_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(fd)
        backup = sqlite3.connect(backup_path)
        db.backup(backup)
        backup.close()
        with db:
            for table in reversed(TABLES):
                db.execute(f"DELETE FROM {table}")
            for table in TABLES:
                columns = {r[1] for r in db.execute(f"PRAGMA table_info({table})")}
                for row in data["rows"][table]:
                    item = {k: v for k, v in row.items() if k in columns}
                    if table in ("uploads", "shares"):
                        item["backend"] = "r2"
                    if table == "uploads":
                        item["staging_cleaned"] = 1
                    keys = list(item)
                    db.execute(f"INSERT INTO {table}({','.join(keys)}) VALUES({','.join('?' for _ in keys)})", list(item.values()))
            used = db.execute("SELECT coalesce(sum(size),0) FROM shares WHERE state!='deleted'").fetchone()[0]
            if used != data["usage"]["used"] or data["usage"]["reserved"] != 0:
                raise ValueError("Authority/usage mismatch; transaction rolled back")
        db.close()
        return str(backup_path)
    finally:
        os.close(lock_fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshot")
    parser.add_argument("database")
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--writers-frozen", action="store_true")
    args = parser.parse_args()
    if not args.writers_frozen:
        parser.error("Freeze V3 and stop Go before --writers-frozen")
    try:
        backup = restore_database(args.snapshot, args.database, args.bucket)
        print(json.dumps({"database": args.database, "backup": backup}))
    except (ValueError, OSError, sqlite3.Error) as e:
        parser.exit(1, f"Rollback refused: {e}\n")


if __name__ == "__main__":
    main()
