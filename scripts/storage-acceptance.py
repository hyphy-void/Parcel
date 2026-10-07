#!/usr/bin/env python3
"""Actual ENOSPC and absent-mount acceptance using a disposable ext4 loop image.
Requires passwordless sudo, mount, mkfs.ext4. Never changes an existing mount.
"""
import errno
import http.cookiejar
import json
import os
from pathlib import Path
import secrets
import hashlib
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

root = Path(__file__).resolve().parents[1]
report = {'date': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'checks': {}}
with tempfile.TemporaryDirectory(prefix='.parcel-storage-', dir=root) as tmp:
    work = Path(tmp); mount = work / 'mount'; mount.mkdir(); image = work / 'volume.ext4'; proc = None; mounted = False
    sock = socket.socket(); sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]; sock.close()
    base = f'http://127.0.0.1:{port}'
    binary = str(work / 'parcel-under-test')
    shutil.copy2(root / 'bin/parcel', binary)
    report['binary_sha256'] = hashlib.sha256(Path(binary).read_bytes()).hexdigest()
    report['version'] = subprocess.check_output([binary, 'version'], text=True).strip()
    env = {**os.environ, 'PARCEL_LISTEN_ADDR': f'127.0.0.1:{port}', 'PARCEL_BASE_URL': base, 'PARCEL_DATA_DIR': str(mount / 'data'), 'PARCEL_REQUIRED_MOUNT': str(mount), 'PARCEL_MIN_FREE_BYTES': '0', 'PARCEL_MAX_FILE_BYTES': str(8 << 20), 'PARCEL_STORAGE_QUOTA_BYTES': str(20 << 20), 'PARCEL_CLEANUP_INTERVAL': '1h'}
    jar = http.cookiejar.CookieJar(); client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar)); csrf = ''
    def api(method, path, data=None, expected=200, headers=None):
        raw = data if isinstance(data, bytes) else json.dumps(data).encode() if data else None
        req = urllib.request.Request(base + '/api/v1' + path, raw, {'Origin': base, 'X-CSRF-Token': csrf, **(headers or {})}, method=method)
        try: r = client.open(req, timeout=30)
        except urllib.error.HTTPError as e: r = e
        with r:
            b = r.read(); assert r.status == expected, (r.status, b[:500]); return json.loads(b)
    try:
        with image.open('wb') as f: f.truncate(48 << 20)
        subprocess.run(['mkfs.ext4', '-q', '-F', str(image)], check=True)
        subprocess.run(['sudo', '-n', 'mount', '-o', 'loop', str(image), str(mount)], check=True); mounted = True
        subprocess.run(['sudo', '-n', 'chown', f'{os.getuid()}:{os.getgid()}', str(mount)], check=True)
        password = secrets.token_urlsafe(18)
        subprocess.run([binary, 'admin-password', '--password-stdin'], input=password + '\n', text=True, env=env, stdout=subprocess.DEVNULL, check=True)
        with (work / 'server.log').open('w') as log:
            proc = subprocess.Popen([binary, 'serve'], env=env, stdout=log, stderr=log)
            for _ in range(100):
                try:
                    with client.open(base + '/readyz', timeout=1) as r: assert r.status == 200
                    break
                except OSError: time.sleep(.1)
            csrf = api('POST', '/auth/login', {'password': password})['csrf']
            u = api('POST', '/uploads', {'name': 'space.bin', 'size': 6 << 20}, 201)
            filler = mount / 'filler'
            fd = os.open(filler, os.O_CREAT | os.O_WRONLY, 0o600)
            try:
                while True: os.write(fd, bytes(1 << 20))
            except OSError as e:
                assert e.errno == errno.ENOSPC
            finally: os.close(fd)
            response = api('PATCH', '/uploads/' + u['id'], bytes(6 << 20), 507, {'Upload-Offset': '0'})
            assert response['code'] == 'chunk_failed', response
            assert api('GET', '/uploads/' + u['id'])['offset'] == 0
            assert (mount / 'data/tmp' / (u['id'] + '.part')).stat().st_size == 0
            report['checks']['real_enospc_no_offset_advance_no_partial_publication'] = True
            filler.unlink()
            assert api('PATCH', '/uploads/' + u['id'], bytes(6 << 20), headers={'Upload-Offset': '0'})['offset'] == 6 << 20
            report['checks']['same_upload_resumes_after_space_recovered'] = True
            proc.terminate(); proc.wait(timeout=30); proc = None
        subprocess.run(['sudo', '-n', 'umount', str(mount)], check=True); mounted = False
        result = subprocess.run([binary, 'serve'], env=env, capture_output=True, text=True, timeout=10)
        assert result.returncode != 0 and '不是已挂载的文件系统' in result.stderr, result.stderr
        assert not (mount / 'data').exists()
        report['checks']['missing_mount_refused_without_fallback_write'] = True
        report['passed'] = True
    except Exception as e:
        report['passed'] = False; report['failure'] = repr(e); raise
    finally:
        if proc and proc.poll() is None: proc.terminate(); proc.wait(timeout=30)
        if mounted: subprocess.run(['sudo', '-n', 'umount', str(mount)], check=True)
        (root / 'docs/storage-acceptance-results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps(report, ensure_ascii=False, indent=2))
