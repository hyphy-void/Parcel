"""Exercise actual Parcel startup/readiness and rollback without touching systemd."""
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from test_update import u


@unittest.skipUnless(os.environ.get('PARCEL_TEST_BINARY'), 'Set PARCEL_TEST_BINARY to a native built Parcel binary')
class LiveUpgradeTests(unittest.TestCase):
    def test_live_upgrade_and_bad_release_rollback_preserve_database(self):
        with tempfile.TemporaryDirectory(prefix='parcel-upgrade-test-') as temp:
            root = Path(temp)
            binary = root / 'parcel'
            candidate = root / 'candidate'
            shutil.copyfile(os.environ['PARCEL_TEST_BINARY'], binary)
            shutil.copyfile(binary, candidate)
            binary.chmod(0o755)
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0))
                port = sock.getsockname()[1]
            url = f'http://127.0.0.1:{port}'
            env = dict(os.environ, PARCEL_DATA_DIR=str(root / 'data'), PARCEL_BASE_URL=url, PARCEL_LISTEN_ADDR=f'127.0.0.1:{port}', PARCEL_REQUIRED_MOUNT='', PARCEL_MIN_FREE_BYTES='0')
            subprocess.run([str(binary), 'admin-password', '--password-stdin'], input='integration-password\n', text=True, env=env, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            process = None
            def control(command):
                nonlocal process
                if command == 'stop':
                    if process and process.poll() is None:
                        process.terminate()
                        process.wait(timeout=15)
                else:
                    process = subprocess.Popen([str(binary), 'serve'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            real_health = u.healthy
            def readiness(address, attempts=30):
                return real_health(address, attempts=3)
            try:
                with patch.object(u, 'BINARY', binary), patch.object(u, 'systemctl', side_effect=control), patch.object(u, 'active', side_effect=lambda: process is not None and process.poll() is None), patch.object(u, 'healthy', side_effect=readiness):
                    control('start')
                    self.assertTrue(readiness(url + '/readyz'))
                    schema = u.database_schema({'PARCEL_DATA_DIR': str(root / 'data')})
                    old = binary.read_bytes()
                    u.upgrade(candidate, url + '/readyz')
                    self.assertTrue(readiness(url + '/readyz'))
                    candidate.write_text('#!/bin/sh\nexit 1\n')
                    with self.assertRaisesRegex(RuntimeError, 'New service failed'):
                        u.upgrade(candidate, url + '/readyz')
                    self.assertEqual(binary.read_bytes(), old)
                    self.assertTrue(readiness(url + '/readyz'))
                    self.assertEqual(u.database_schema({'PARCEL_DATA_DIR': str(root / 'data')}), schema)
            finally:
                control('stop')
