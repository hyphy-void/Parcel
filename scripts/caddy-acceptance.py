#!/usr/bin/env python3
"""Verify the Caddy access boundary using isolated loopback services and data."""
import argparse
import http.client
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import time
from urllib.parse import urlsplit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True)
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    origin = "http://parcel-check.local:18780"
    with tempfile.TemporaryDirectory(prefix="parcel-caddy-check-") as directory:
        root = Path(directory)
        env = {k: v for k, v in os.environ.items() if not k.startswith("PARCEL_")}
        env.update(PARCEL_DATA_DIR=str(root / "data"), PARCEL_BASE_URL=origin,
                   PARCEL_LISTEN_ADDR="127.0.0.1:18080", PARCEL_REQUIRED_MOUNT="",
                   PARCEL_TRUSTED_PROXIES="127.0.0.1/32", PARCEL_MIN_FREE_BYTES="0")
        password = secrets.token_urlsafe(24)
        subprocess.run([args.binary, "admin-password", "--password-stdin"],
                       input=password + "\n", text=True, env=env, check=True,
                       stdout=subprocess.DEVNULL)
        source = Path(args.config).read_text().splitlines()
        lines = []
        for line in source:
            if "@management remote_ip" in line:
                line = "\t@management remote_ip 127.0.0.1/32"
            lines.append(line.replace("127.0.0.1:8080", "127.0.0.1:18080"))
        # The sample starts with comments, so replace the first top-level site explicitly.
        for index, line in enumerate(lines):
            if line and not line[0].isspace() and not line.startswith("#") and line.endswith(" {"):
                lines[index] = origin + " {"
                break
        config = root / "Caddyfile"
        config.write_text("{\n admin off\n auto_https off\n}\n" + "\n".join(lines))
        with (root / "logs").open("w+") as logs:
            processes = []
            try:
                processes.append(subprocess.Popen([args.binary, "serve"], env=env, stdout=logs, stderr=logs))
                processes.append(subprocess.Popen(["caddy", "run", "--config", str(config), "--adapter", "caddyfile"],
                                                  stdout=logs, stderr=logs))

                def request(method, path, body=None, headers=None, public=False):
                    conn = http.client.HTTPConnection("127.0.0.1", 18780, timeout=5,
                                                      source_address=("127.0.0.2" if public else "127.0.0.1", 0))
                    fields = {"Host": "parcel-check.local:18780", "Origin": origin}
                    fields.update(headers or {})
                    if isinstance(body, dict):
                        body = json.dumps(body)
                        fields["Content-Type"] = "application/json"
                    try:
                        conn.request(method, path, body=body, headers=fields)
                        response = conn.getresponse()
                        return response.status, dict(response.getheaders()), response.read()
                    finally:
                        conn.close()

                deadline = time.monotonic() + 15
                while True:
                    try:
                        if request("GET", "/readyz")[0] == 200:
                            break
                    except OSError:
                        pass
                    if time.monotonic() > deadline:
                        raise RuntimeError("isolated services did not become ready")
                    time.sleep(0.2)
                private = ["/", "/login", "/admin", "/admin/new", "/api/v1/auth/login",
                           "/api/v1/auth/session", "/api/v1/auth/logout", "/api/v1/admin/status",
                           "/api/v1/admin/shares", "/api/v1/uploads", "/api/v1/uploads/lookup",
                           "/api/v1/uploads/test/complete", "/healthz", "/readyz", "/future-admin"]
                for path in private:
                    for method in ("GET", "POST", "PATCH", "DELETE", "HEAD"):
                        status, _, _ = request(method, path, headers={"X-Forwarded-For": "127.0.0.1",
                                                                     "X-Real-IP": "127.0.0.1"}, public=True)
                        assert status == 403, (method, path, status)
                status, headers, raw = request("POST", "/api/v1/auth/login", {"password": password})
                assert status == 200, status
                auth = {"Cookie": headers["Set-Cookie"].split(";", 1)[0], "X-CSRF-Token": json.loads(raw)["csrf"]}
                payload = b"isolated Caddy acceptance file"
                status, _, raw = request("POST", "/api/v1/uploads", {"name": "check.txt", "size": len(payload),
                                                                       "max_downloads": 1}, auth)
                assert status == 201, (status, raw)
                upload = json.loads(raw)
                path = "/api/v1/uploads/" + upload["id"]
                status, _, _ = request("PATCH", path, payload, {**auth, "Upload-Offset": "0"})
                assert status == 200, status
                assert request("POST", path + "/complete", headers=auth)[0] == 202
                for _ in range(50):
                    status, _, raw = request("GET", path, headers=auth)
                    if status == 200 and json.loads(raw)["state"] == "completed":
                        break
                    time.sleep(0.1)
                else:
                    raise RuntimeError("upload did not finalize")
                share = upload["share_id"]
                assert request("GET", "/s/" + share, public=True)[0] == 200
                status, _, raw = request("POST", "/api/v1/shares/" + share + "/download-sessions", public=True)
                assert status == 201, status
                ticket = urlsplit(json.loads(raw)["url"]).path
                status, headers, first = request("GET", ticket, headers={"Range": "bytes=0-6"}, public=True)
                assert status == 206 and first == payload[:7]
                assert headers["Cache-Control"] == "private, no-store"
                status, _, rest = request("GET", ticket, headers={"Range": "bytes=7-"}, public=True)
                assert status == 206 and first + rest == payload
                status, _, raw = request("GET", "/api/v1/admin/shares/" + share, headers=auth)
                assert status == 200 and json.loads(raw)["download_count"] == 1
                assert request("DELETE", "/api/v1/admin/shares/" + share, headers=auth)[0] == 200
                assert request("GET", ticket, public=True)[0] == 410
                print("PASS: private routes denied (including spoofed IP headers); public share, upload, Range resume, single count and revocation")
            finally:
                for process in reversed(processes):
                    process.terminate()
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()


if __name__ == "__main__":
    main()
