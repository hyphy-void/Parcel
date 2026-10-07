#!/usr/bin/env python3
"""Real file/process acceptance on the target host. No external Python packages.
Creates and removes its own isolated data directory; never touches a running Parcel.
Default: 8 GiB + restart/Range/SHA-256 + 2 uploads/4 downloads/1 verification load.
"""
import argparse
import hashlib
import http.client
import http.cookiejar
import json
import os
from pathlib import Path
import platform
import secrets
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--size', type=int, default=8 << 30)
    parser.add_argument('--report', default=str(ROOT / 'docs/acceptance-results.json'))
    parser.add_argument('--skip-stress', action='store_true')
    args = parser.parse_args()
    if args.size < 1:
        parser.error('--size must be positive')
    report = {'date': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'host': platform.node(), 'architecture': platform.machine(), 'bytes': args.size, 'checks': {}, 'rss_peak_kib': 0, 'timings_seconds': {}}
    with tempfile.TemporaryDirectory(prefix='.parcel-acceptance-', dir=ROOT) as tmp:
        work = Path(tmp)
        sock = socket.socket(); sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]; sock.close()
        base = f'http://127.0.0.1:{port}'
        env = {**os.environ, 'PARCEL_LISTEN_ADDR': f'127.0.0.1:{port}', 'PARCEL_BASE_URL': base, 'PARCEL_DATA_DIR': str(work / 'data'), 'PARCEL_MAX_FILE_BYTES': str(max(args.size, 8 << 20)), 'PARCEL_STORAGE_QUOTA_BYTES': str(max(args.size * 2 + (1 << 30), 1 << 30)), 'PARCEL_MIN_FREE_BYTES': '0', 'PARCEL_REQUIRED_MOUNT': '/', 'PARCEL_CLEANUP_INTERVAL': '1s', 'GOMEMLIMIT': '192MiB'}
        binary = str(work / 'parcel-under-test')
        shutil.copy2(ROOT / 'bin/parcel', binary)
        report['binary_sha256'] = hashlib.sha256(Path(binary).read_bytes()).hexdigest()
        report['version'] = subprocess.check_output([binary, 'version'], text=True).strip()
        report['go_build'] = subprocess.check_output(['go', 'version', '-m', binary], text=True).strip()
        tree = hashlib.sha256()
        sources = [ROOT / 'go.mod', ROOT / 'go.sum', *(ROOT / 'cmd').rglob('*.go'), *(ROOT / 'internal').rglob('*.go'), *(ROOT / 'internal').rglob('*.sql'), ROOT / 'web/embed.go', *(ROOT / 'web/src').rglob('*'), ROOT / 'web/package-lock.json']
        for p in sorted(p for p in sources if p.is_file()):
            tree.update(str(p.relative_to(ROOT)).encode()); tree.update(p.read_bytes())
        report['source_tree_sha256'] = tree.hexdigest()
        password = secrets.token_urlsafe(24)
        subprocess.run([binary, 'admin-password', '--password-stdin'], input=password + '\n', text=True, env=env, check=True, stdout=subprocess.DEVNULL)
        jar = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
        proc = None
        log = (work / 'server.log').open('w')
        stop_sample = threading.Event()

        def start():
            nonlocal proc
            proc = subprocess.Popen([binary, 'serve'], env=env, stdout=log, stderr=log)
            for _ in range(300):
                if proc.poll() is not None:
                    raise RuntimeError((work / 'server.log').read_text())
                try:
                    with opener.open(base + '/readyz', timeout=1) as r:
                        if r.status == 200: return
                except (OSError, urllib.error.URLError): pass
                time.sleep(.1)
            raise RuntimeError('readiness timeout')

        def stop(kill=False):
            nonlocal proc
            if proc and proc.poll() is None:
                proc.send_signal(signal.SIGKILL if kill else signal.SIGTERM)
                proc.wait(timeout=30)

        def sample():
            while not stop_sample.wait(.025):
                try:
                    pid = proc.pid if proc else 0
                    for line in Path(f'/proc/{pid}/status').read_text().splitlines():
                        if line.startswith('VmRSS:'):
                            report['rss_peak_kib'] = max(report['rss_peak_kib'], int(line.split()[1]))
                except (OSError, ProcessLookupError): pass

        csrf = ''
        def api(method, path, data=None, headers=None, expected=200):
            raw = data if isinstance(data, bytes) else json.dumps(data).encode() if data is not None else None
            h = {'Origin': base, 'X-CSRF-Token': csrf, 'Content-Type': 'application/octet-stream' if isinstance(data, bytes) else 'application/json', **(headers or {})}
            req = urllib.request.Request(base + '/api/v1' + path, raw, h, method=method)
            try: response = opener.open(req, timeout=180)
            except urllib.error.HTTPError as e: response = e
            with response:
                body = response.read()
                assert response.status == expected, (path, response.status, body[:500])
                return json.loads(body)

        def create(name, size):
            return api('POST', '/uploads', {'name': name, 'size': size, 'max_downloads': 3}, expected=201)

        def send(u, source, offset=0, end=None):
            end = args.size if end is None else end
            source.seek(offset)
            while offset < end:
                chunk = source.read(min(8 << 20, end - offset))
                assert chunk
                result = api('PATCH', '/uploads/' + u['id'], chunk, {'Upload-Offset': str(offset)})
                offset = result['offset']
                if offset % (1 << 30) == 0: print(f'Upload confirmed: {offset >> 30} GiB', flush=True)

        def published(u):
            for _ in range(1800):
                current = api('GET', '/uploads/' + u['id'])
                if current['state'] == 'completed': return api('GET', '/admin/shares/' + current['share_id'])
                assert current['state'] == 'finalizing', current
                time.sleep(.2)
            raise RuntimeError('verification timeout')

        sampler = threading.Thread(target=sample, daemon=True); sampler.start()
        try:
            start()
            csrf = api('POST', '/auth/login', {'password': password})['csrf']
            block = bytes(range(256)) * (32768)
            source_path = work / 'source.bin'
            expected = hashlib.sha256()
            print(f'Creating a real {args.size} byte source on SSD…', flush=True)
            t = time.monotonic()
            with source_path.open('wb') as f:
                remaining = args.size
                while remaining:
                    b = block[:min(remaining, len(block))]
                    f.write(b); expected.update(b); remaining -= len(b)
                f.flush(); os.fsync(f.fileno())
            report['timings_seconds']['source'] = round(time.monotonic() - t, 3)
            expected = expected.hexdigest()
            u = create('8GiB-验收.bin', args.size)
            t = time.monotonic()
            half = args.size // 2
            with source_path.open('rb') as source: send(u, source, end=half)
            stop(kill=True)
            part = work / 'data/tmp' / (u['id'] + '.part')
            with part.open('ab') as f: f.write(b'unacknowledged-tail'); f.flush(); os.fsync(f.fileno())
            start()
            assert api('GET', '/uploads/' + u['id'])['offset'] == half
            assert part.stat().st_size == half
            report['checks']['upload_restart_and_tail_recovery'] = True
            with source_path.open('rb') as source: send(u, source, offset=half)
            report['timings_seconds']['upload_including_restart'] = round(time.monotonic() - t, 3)
            api('POST', '/uploads/' + u['id'] + '/complete', expected=202)
            stop(kill=True); start()
            s = published(u)
            assert s['size'] == args.size and s['sha256'] == expected
            report['checks']['verification_restart_and_sha256'] = True
            assert api('POST', '/uploads/' + u['id'] + '/complete')['share_id'] == s['id']
            report['checks']['complete_idempotent'] = True
            ticket = api('POST', '/shares/' + s['id'] + '/download-sessions', expected=201)['url']
            with opener.open(urllib.request.Request(base + ticket, method='HEAD')) as r: assert int(r.headers['Content-Length']) == args.size
            assert api('GET', '/admin/shares/' + s['id'])['download_count'] == 0
            downloaded = work / 'download.bin'; cut = min(4 << 20, args.size)
            t = time.monotonic()
            with opener.open(urllib.request.Request(base + ticket, headers={'Range': f'bytes=0-{cut-1}'})) as r, downloaded.open('wb') as f:
                assert r.status == 206; f.write(r.read())
            stop(kill=True); start()
            if cut < args.size:
                with opener.open(urllib.request.Request(base + ticket, headers={'Range': f'bytes={cut}-'}), timeout=180) as r, downloaded.open('ab') as f:
                    assert r.status == 206
                    while b := r.read(256 << 10): f.write(b)
            got = hashlib.sha256()
            with downloaded.open('rb') as f:
                while b := f.read(1 << 20): got.update(b)
            assert downloaded.stat().st_size == args.size and got.hexdigest() == expected
            assert api('GET', '/admin/shares/' + s['id'])['download_count'] == 1
            report['sha256'] = expected
            report['checks']['range_restart_full_sha256_and_single_count'] = True
            report['timings_seconds']['download_including_restart_and_hash'] = round(time.monotonic() - t, 3)
            print('Full upload/restart/download checksum verified.', flush=True)

            if not args.skip_stress:
                second = create('校验负载.bin', args.size)
                with source_path.open('rb') as source: send(second, source)
                dummy = [create(f'并发上传-{i}.bin', len(block)) for i in range(2)]
                cookies = '; '.join(c.name + '=' + c.value for c in jar)
                errors = []; download_stop = threading.Event()
                def slow_upload(u):
                    try:
                        conn = http.client.HTTPConnection('127.0.0.1', port, timeout=60)
                        conn.putrequest('PATCH', '/api/v1/uploads/' + u['id'])
                        for k, v in {'Origin': base, 'Cookie': cookies, 'X-CSRF-Token': csrf, 'Upload-Offset': '0', 'Content-Length': str(len(block))}.items(): conn.putheader(k, v)
                        conn.endheaders()
                        for n in range(0, len(block), 64 << 10): conn.send(block[n:n+(64 << 10)]); time.sleep(.04)
                        r = conn.getresponse(); assert r.status == 200, (r.status, r.read()); r.read(); conn.close()
                    except Exception as e: errors.append(repr(e))
                def slow_download():
                    try:
                        request = urllib.request.Request(base + ticket, headers={'Range': f'bytes=0-{min(args.size,64<<20)-1}'})
                        with urllib.request.urlopen(request, timeout=60) as r:
                            assert r.status == 206
                            while not download_stop.is_set() and r.read(64 << 10): time.sleep(.05)
                    except Exception as e: errors.append(repr(e))
                downloads = [threading.Thread(target=slow_download) for _ in range(4)]
                uploads = [threading.Thread(target=slow_upload, args=(v,)) for v in dummy]
                for thread in downloads + uploads: thread.start()
                api('POST', '/uploads/' + second['id'] + '/complete', expected=202)
                overlap = None
                for _ in range(150):
                    st = api('GET', '/admin/status')
                    if st['active_uploads'] == 2 and st['active_downloads'] == 4 and st['active_finalizations'] == 1: overlap = st; break
                    time.sleep(.025)
                download_stop.set()
                for thread in downloads + uploads: thread.join(timeout=120); assert not thread.is_alive()
                assert not errors, errors
                assert overlap, 'No measured 2 uploads/4 downloads/1 verification overlap; rerun with full 8 GiB.'
                s2 = published(second)
                assert s2['sha256'] == expected
                report['checks']['two_uploads_four_downloads_one_verification'] = True
                report['concurrency_overlap'] = {k: overlap[k] for k in ('active_uploads', 'active_downloads', 'active_finalizations')}
                for v in dummy: api('DELETE', '/uploads/' + v['id'])
                api('DELETE', '/admin/shares/' + s2['id'])
            api('DELETE', '/admin/shares/' + s['id'])
            for _ in range(100):
                st = api('GET', '/admin/status')
                if st['used_bytes'] == st['reserved_bytes'] == 0: break
                time.sleep(.1)
            assert st['used_bytes'] == st['reserved_bytes'] == 0, st
            report['checks']['revocation_cleanup_and_quota_released'] = True
            report['checks']['rss_under_256_mib'] = report['rss_peak_kib'] < 256 * 1024
            assert report['checks']['rss_under_256_mib'], report['rss_peak_kib']
            report['passed'] = True
        except Exception as e:
            report['passed'] = False; report['failure'] = repr(e)
            raise
        finally:
            stop_sample.set(); sampler.join(timeout=2); stop(); log.close()
            Path(args.report).write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
            print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)


if __name__ == '__main__': main()
