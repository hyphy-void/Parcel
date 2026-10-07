#!/usr/bin/env python3
"""Download verified Parcel releases and upgrade an existing systemd installation."""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shlex
import shutil
import signal
import sqlite3
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request

REPO = 'hyphy-void/Parcel'
CONFIG = Path('/etc/parcel/parcel.env')
UPDATE_CONFIG = Path('/etc/parcel/update.env')
BINARY = Path('/opt/parcel/parcel')
LOCK = Path('/run/lock/parcel-update.lock')
VERSION = re.compile(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)')


def version_tuple(value):
    if not VERSION.fullmatch(value):
        raise ValueError(f'Expected stable version X.Y.Z, got {value!r}')
    return tuple(map(int, value.split('.')))


def config(path):
    """Read literal KEY=value assignments; never execute a configuration file."""
    values = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        key, sep, value = line.partition('=')
        if not sep or not re.fullmatch(r'[A-Z][A-Z0-9_]*', key):
            raise ValueError(f'Invalid assignment in {path}')
        tokens = shlex.split(value, comments=True)
        if len(tokens) > 1:
            raise ValueError(f'Quote values containing spaces in {path}')
        values[key] = tokens[0] if tokens else ''
    return values


def request(url, api=False):
    headers = {'User-Agent': 'Parcel-updater', 'Accept': 'application/vnd.github+json' if api else 'application/octet-stream'}
    # Optional token is used only for API calls, never release download redirects.
    if api and os.environ.get('GH_TOKEN'):
        headers['Authorization'] = 'Bearer ' + os.environ['GH_TOKEN']
    return urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30)


def release(tag):
    suffix = 'latest' if tag == 'latest' else 'tags/' + tag
    with request(f'https://api.github.com/repos/{REPO}/releases/{suffix}', api=True) as response:
        info = json.load(response)
    if info.get('draft') or info.get('prerelease'):
        raise ValueError('Only published stable releases are supported')
    resolved_tag = info['tag_name']
    if tag != 'latest' and resolved_tag != tag:
        raise ValueError('Release tag mismatch')
    tag = resolved_tag
    if not tag.startswith('v'):
        raise ValueError('Release tag must start with v')
    version_tuple(tag[1:])
    return tag


def architecture():
    machine = platform.machine().lower()
    bits = struct.calcsize('P') * 8
    if machine in ('aarch64', 'arm64') and bits == 64:
        return 'arm64'
    if (machine in ('armv7l', 'armv8l', 'aarch64', 'arm64')) and bits == 32:
        return 'arm'
    if machine in ('x86_64', 'amd64') and bits == 64:
        return 'amd64'
    raise ValueError(f'Unsupported architecture: {machine}, {bits}-bit userspace')


def download(tag, name, destination):
    url = f'https://github.com/{REPO}/releases/download/{tag}/{name}'
    with request(url) as response, destination.open('wb') as output:
        shutil.copyfileobj(response, output)


def verify(directory, names):
    sums = {}
    for line in (directory / 'SHA256SUMS').read_text().splitlines():
        match = re.fullmatch(r'([0-9a-f]{64})  ([A-Za-z0-9._-]+)', line)
        if not match or match[2] in sums:
            raise ValueError('Invalid or duplicate SHA256SUMS entry')
        sums[match[2]] = match[1]
    for name in names:
        with (directory / name).open('rb') as source:
            digest = hashlib.sha256()
            for chunk in iter(lambda: source.read(1024 * 1024), b''):
                digest.update(chunk)
            actual = digest.hexdigest()
        if sums.get(name) != actual:
            raise ValueError(f'SHA256 mismatch: {name}')


def installed_version():
    return subprocess.check_output([str(BINARY), 'version'], text=True, timeout=15).strip()


def database_schema(settings):
    data = Path(settings.get('PARCEL_DATA_DIR', '/srv/parcel'))
    if not data.is_absolute():
        raise ValueError('PARCEL_DATA_DIR must be absolute for updates')
    db_path = data / 'parcel.db'
    if not db_path.is_file():
        raise ValueError('Existing initialized database required; use install-systemd.sh for first install')
    with contextlib.closing(sqlite3.connect(db_path.as_uri() + '?mode=ro', uri=True)) as db:
        return db.execute('SELECT max(version) FROM schema_migrations').fetchone()[0]


def systemctl(*args):
    subprocess.run(['systemctl', *args, 'parcel.service'], check=True, timeout=60)


def active():
    return subprocess.run(['systemctl', 'is-active', '--quiet', 'parcel.service'], timeout=15).returncode == 0


def healthy(url, attempts=30):
    for _ in range(attempts):
        if active():
            try:
                with urllib.request.urlopen(url, timeout=2) as response:
                    if response.status == 200 and json.load(response).get('status') == 'ready':
                        return True
            except (OSError, ValueError):
                pass
        time.sleep(1)
    return False


def upgrade(candidate, health_url):
    """Atomic same-filesystem replacement and rollback, including interrupted updates."""
    previous = BINARY.with_name('parcel.previous')
    staged = BINARY.with_name('parcel.next')
    backup_stage = BINARY.with_name('parcel.previous.next')
    stopped = False
    replaced = False
    success = False
    try:
        shutil.copyfile(candidate, staged)
        staged.chmod(0o755)
        shutil.copyfile(BINARY, backup_stage)
        backup_stage.chmod(0o755)
        os.replace(backup_stage, previous)
        # From this point any failure must try to restore the original service.
        stopped = True
        systemctl('stop')
        # Mark before rename so a signal immediately after rename still restores it.
        replaced = True
        os.replace(staged, BINARY)
        systemctl('start')
        if not healthy(health_url):
            raise RuntimeError('New service failed readiness check')
        success = True
    finally:
        if stopped and not success:
            print('Update failed; restoring previous service.', file=sys.stderr)
            # Do not replace a live executable before stop has succeeded.
            if replaced:
                systemctl('stop')
                shutil.copyfile(previous, staged)
                staged.chmod(0o755)
                os.replace(staged, BINARY)
            systemctl('start')
            if not healthy(health_url):
                raise RuntimeError('Rollback readiness failed; inspect journalctl -u parcel')
            print('Previous service restored.', file=sys.stderr)
        for path in (staged, backup_stage):
            path.unlink(missing_ok=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--version', default='latest', help='vX.Y.Z / X.Y.Z or latest')
    parser.add_argument('--check', action='store_true', help='Report available version without installing')
    parser.add_argument('--auto', action='store_true', help='Respect opt-in and update only newer patches in current X.Y')
    args = parser.parse_args(argv)
    if os.geteuid() != 0:
        raise ValueError('Run with sudo (configuration and update lock are root-owned)')
    settings = config(CONFIG)
    updates = config(UPDATE_CONFIG) if UPDATE_CONFIG.exists() else {}
    if args.auto and updates.get('PARCEL_AUTO_UPDATE', 'false') != 'true':
        print('Automatic updates are disabled.')
        return
    if args.auto and args.version != 'latest':
        raise ValueError('--auto requires latest')
    tag = args.version
    if tag != 'latest':
        tag = 'v' + tag.removeprefix('v')
        version_tuple(tag[1:])
    with LOCK.open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Another Parcel update is running') from None
        current = installed_version()
        tag = release(tag)
        target = tag[1:]
        print(f'Installed: {current}; release: {target}')
        if current == target:
            return
        if args.auto:
            old, new = version_tuple(current), version_tuple(target)
            if old[:2] != new[:2] or new <= old:
                print('Automatic update skipped: requires a newer patch within current X.Y.')
                return
        if args.check:
            return
        if not active():
            raise ValueError('Parcel must be running before upgrading')
        url = updates.get('PARCEL_HEALTH_URL') or settings.get('PARCEL_BASE_URL', '').rstrip('/') + '/readyz'
        if not url.startswith(('http://', 'https://')):
            raise ValueError('Configure PARCEL_BASE_URL or PARCEL_HEALTH_URL')
        if not healthy(url, attempts=1):
            raise ValueError('Current service is unhealthy; resolve before upgrading')
        name = 'parcel-linux-' + architecture()
        with tempfile.TemporaryDirectory(prefix='parcel-update-') as temp:
            directory = Path(temp)
            for asset in ('SHA256SUMS', 'release.json', name):
                download(tag, asset, directory / asset)
            verify(directory, ('release.json', name))
            metadata = json.loads((directory / 'release.json').read_text())
            if metadata.get('version') != target:
                raise ValueError('Release metadata version mismatch')
            if metadata.get('schema_version') != database_schema(settings):
                raise ValueError('Schema-changing release requires manual backup and migration; automatic binary rollback is unsafe')
            candidate = directory / name
            candidate.chmod(0o755)
            built_version = subprocess.check_output([str(candidate), 'version'], text=True, timeout=15).strip()
            if built_version != target:
                raise ValueError('Downloaded binary version mismatch')
            upgrade(candidate, url)
        print(f'Updated to {target}; readiness passed. Previous binary: {BINARY.with_name("parcel.previous")}')


if __name__ == '__main__':
    def interrupted(signum, frame):
        raise KeyboardInterrupt(f'Interrupted by signal {signum}')
    signal.signal(signal.SIGTERM, interrupted)
    try:
        main()
    except (Exception, KeyboardInterrupt) as error:
        print(f'Parcel update failed: {error}', file=sys.stderr)
        sys.exit(1)
