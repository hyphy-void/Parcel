#!/usr/bin/env python3
"""Export a quiesced Go schema-3/4 R2 database. Never transfers or removes objects."""
import argparse
import hashlib
import fcntl
import json
import os
import sqlite3
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TABLES = ("uploads", "shares", "share_grants", "download_sessions")


def _export_database(path, bucket, now=None):
    now = int(time.time()) if now is None else now
    if not bucket or any(c not in "abcdefghijklmnopqrstuvwxyz0123456789-" for c in bucket):
        raise ValueError("Specify the existing R2 bucket name")
    source = sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True)
    snapshot = sqlite3.connect(":memory:")
    try:
        source.backup(snapshot)
    finally:
        source.close()
    snapshot.row_factory = sqlite3.Row
    schema = snapshot.execute("SELECT max(version) FROM schema_migrations").fetchone()[0]
    if schema not in (3, 4):
        raise ValueError("Only verified Go schema 3 or 4 can be exported")
    if snapshot.execute("SELECT count(*) FROM uploads WHERE state NOT IN ('completed','cleaned')").fetchone()[0]:
        raise ValueError("Finish or cancel all uploads, then freeze Go writers and cleanup")
    if snapshot.execute("SELECT count(*) FROM uploads WHERE backend='r2' AND (put_expires>? OR (state='completed' AND part_bytes=0 AND staging_cleaned=0))", (now,)).fetchone()[0]:
        raise ValueError("Wait for legacy PUT URLs to expire and staging objects to be cleaned")
    if snapshot.execute("SELECT count(*) FROM shares WHERE backend!='r2'").fetchone()[0]:
        raise ValueError("Local-file shares need separate object migration; no silent data loss")
    target = sqlite3.connect(":memory:")
    for migration in sorted((ROOT / "cloudflare/v3/migrations").glob("*.sql")):
        target.executescript(migration.read_text())
    rows = {}
    for table in TABLES:
        columns = {r[1] for r in target.execute(f"PRAGMA table_info({table})")}
        items = []
        query = f"SELECT * FROM {table}"
        if table == "uploads":
            query += " WHERE backend='r2'"
        for r in snapshot.execute(query):
            item = {k: r[k] for k in r.keys() if k in columns}
            if table == "uploads":
                item["part_bytes"] = item["part_bytes"] or 16777216
            if table == "shares":
                item["signed_until"] = max(item["signed_until"], snapshot.execute("SELECT coalesce(max(expires),0) FROM download_sessions WHERE share_id=?", (item["id"],)).fetchone()[0])
            items.append(item)
        rows[table] = items
    # Let target constraints and foreign keys validate the entire graph.
    target.execute("PRAGMA foreign_keys=ON")
    for table, items in rows.items():
        for item in items:
            columns = list(item)
            target.execute(f"INSERT INTO {table}({','.join(columns)}) VALUES({','.join('?' for _ in columns)})", list(item.values()))
    usage = target.execute("SELECT used,reserved FROM storage_usage").fetchone()
    payload = json.dumps({"format": 1, "source": f"go-sqlite-schema{schema}", "bucket": bucket, "exported": now, "rows": rows, "usage": {"used": usage[0], "reserved": usage[1]}}, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    snapshot.close()
    target.close()
    return {"sha256": hashlib.sha256(payload.encode()).hexdigest(), "payload": payload}


def export_database(path, bucket, now=None):
    lock_fd = os.open(Path(path).resolve().parent / ".lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return _export_database(path, bucket, now)
    finally:
        os.close(lock_fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database")
    parser.add_argument("output")
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--writers-frozen", action="store_true", help="Confirm Go writes and cleanup have stopped")
    args = parser.parse_args()
    if not args.writers_frozen:
        parser.error("Stop Go writers/cleanup and pass --writers-frozen")
    try:
        manifest = export_database(args.database, args.bucket)
        path = Path(args.output)
        path.parent.mkdir(parents=True, exist_ok=True)
        with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as f:
            json.dump(manifest, f, ensure_ascii=False)
        data = json.loads(manifest["payload"])
        print(json.dumps({"output": str(path), "sha256": manifest["sha256"], "counts": {k: len(v) for k, v in data["rows"].items()}, "usage": data["usage"]}))
    except (ValueError, sqlite3.Error, OSError) as e:
        parser.exit(1, f"Export refused: {e}\n")


if __name__ == "__main__":
    main()
