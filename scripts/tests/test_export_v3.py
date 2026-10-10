import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("export_v3", ROOT / "scripts/export-v3.py")
EXPORT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(EXPORT)


class ExportV3Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "source.sqlite"
        self.db = sqlite3.connect(self.path)
        self.addCleanup(self.db.close)
        for name in ["001", "002", "003"]:
            self.db.executescript((ROOT / f"internal/parcel/migrations/{name}.sql").read_text())
        self.db.execute("INSERT INTO uploads(id,name,size,ttl,max_downloads,state,storage_key,share_id,created,updated,backend,part_bytes) VALUES('upload','file',7,3600,3,'completed','parcel/old/key','share',1,1,'r2',16777216)")
        self.db.execute("INSERT INTO shares(id,upload_id,storage_key,name,size,sha256,created,expires,max_downloads,backend,etag,signed_until,download_count) VALUES('share','upload','parcel/old/key','file',7,'',1,3601,3,'r2','etag',10,1)")
        self.db.execute("INSERT INTO download_sessions(token_hash,share_id,version,state,created,activated,last_activity,expires) VALUES('hash','share',1,'active',1,1,1,500)")
        self.db.commit()

    def test_preserves_authority_and_extends_existing_session_retention(self):
        result = EXPORT.export_database(self.path, "parcel-test", now=100)
        data = json.loads(result["payload"])
        self.assertEqual(data["usage"], {"used": 7, "reserved": 0})
        self.assertEqual(data["rows"]["shares"][0]["download_count"], 1)
        self.assertEqual(data["rows"]["shares"][0]["signed_until"], 500)
        self.assertEqual(data["rows"]["download_sessions"][0]["token_hash"], "hash")
        self.assertNotIn("admin_credentials", data["rows"])

    def test_refuses_in_flight_uploads(self):
        self.db.execute("UPDATE uploads SET state='uploading'")
        self.db.commit()
        with self.assertRaisesRegex(ValueError, "freeze"):
            EXPORT.export_database(self.path, "parcel-test")

    def test_refuses_legacy_urls_staging_and_local_objects(self):
        self.db.execute("UPDATE uploads SET part_bytes=0,staging_cleaned=0")
        self.db.commit()
        with self.assertRaisesRegex(ValueError, "staging"):
            EXPORT.export_database(self.path, "parcel-test")
        self.db.execute("UPDATE uploads SET staging_cleaned=1,put_expires=200")
        self.db.commit()
        with self.assertRaisesRegex(ValueError, "PUT"):
            EXPORT.export_database(self.path, "parcel-test", now=100)
        self.db.execute("UPDATE uploads SET put_expires=0")
        self.db.execute("UPDATE shares SET backend='local'")
        self.db.commit()
        with self.assertRaisesRegex(ValueError, "Local-file"):
            EXPORT.export_database(self.path, "parcel-test")

    def test_rollback_preserves_new_d1_counts_and_original_go_admin_data(self):
        import hashlib
        spec = importlib.util.spec_from_file_location("rollback_v3", ROOT / "scripts/rollback-v3.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.db.execute("INSERT INTO admin_credentials(id,password_hash,version) VALUES(1,'original-admin',4)")
        self.db.commit()
        data = json.loads(EXPORT.export_database(self.path, "parcel-test", now=100)["payload"])
        data["source"] = "d1-v3"
        data["rows"]["shares"][0]["download_count"] = 2
        payload = json.dumps(data)
        snapshot = Path(self.temp.name) / "rollback.json"
        snapshot.write_text(json.dumps({"payload": payload, "sha256": hashlib.sha256(payload.encode()).hexdigest()}))
        backup = module.restore_database(snapshot, self.path, "parcel-test")
        self.assertTrue(Path(backup).exists())
        self.assertEqual(self.db.execute("SELECT download_count FROM shares").fetchone()[0], 2)
        self.assertEqual(self.db.execute("SELECT password_hash,version FROM admin_credentials").fetchone(), ("original-admin", 4))
        self.assertEqual(self.db.execute("SELECT backend FROM shares").fetchone()[0], "r2")
        data["usage"]["used"] = 999
        payload = json.dumps(data)
        snapshot.write_text(json.dumps({"payload": payload, "sha256": hashlib.sha256(payload.encode()).hexdigest()}))
        with self.assertRaisesRegex(ValueError, "mismatch"):
            module.restore_database(snapshot, self.path, "parcel-test")
        self.assertEqual(self.db.execute("SELECT download_count FROM shares").fetchone()[0], 2)

    def test_rollback_refuses_encrypted_verifiers_before_touching_sqlite(self):
        import hashlib
        spec = importlib.util.spec_from_file_location("rollback_v3", ROOT / "scripts/rollback-v3.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        data = json.loads(EXPORT.export_database(self.path, "parcel-test", now=100)["payload"])
        data["source"] = "d1-v3"
        data["rows"]["shares"][0]["password_hash"] = "$parcel-a2$encrypted"
        payload = json.dumps(data)
        snapshot = Path(self.temp.name) / "encrypted.json"
        snapshot.write_text(json.dumps({"payload":payload,"sha256":hashlib.sha256(payload.encode()).hexdigest()}))
        with self.assertRaisesRegex(ValueError,"SESSION_SECRET"):
            module.restore_database(snapshot,self.path,"parcel-test")
        self.assertEqual(self.db.execute("SELECT download_count,password_hash FROM shares").fetchone(),(1,""))
        self.assertEqual(list(self.path.parent.glob("*.before-v3-rollback-*")),[])

    def test_export_refuses_a_running_go_process_lock(self):
        import fcntl
        import os
        fd = os.open(self.path.parent / ".lock", os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                EXPORT.export_database(self.path, "parcel-test")
        finally:
            os.close(fd)
