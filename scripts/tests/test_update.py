import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('parcel_update', Path(__file__).parents[1] / 'update.py')
u = importlib.util.module_from_spec(spec)
spec.loader.exec_module(u)


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.binary = self.root / 'parcel'
        self.binary.write_bytes(b'old-binary')
        self.candidate = self.root / 'candidate'
        self.candidate.write_bytes(b'new-binary')
        self.patch = patch.object(u, 'BINARY', self.binary)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def test_atomic_upgrade_preserves_previous(self):
        with patch.object(u, 'systemctl') as service, patch.object(u, 'healthy', return_value=True):
            u.upgrade(self.candidate, 'http://localhost/readyz')
        self.assertEqual(self.binary.read_bytes(), b'new-binary')
        self.assertEqual(self.binary.with_name('parcel.previous').read_bytes(), b'old-binary')
        self.assertEqual([c.args for c in service.call_args_list], [('stop',), ('start',)])
        self.assertFalse(self.binary.with_name('parcel.next').exists())

    def test_unhealthy_upgrade_restores_old_binary(self):
        with patch.object(u, 'systemctl') as service, patch.object(u, 'healthy', side_effect=[False, True]):
            with self.assertRaisesRegex(RuntimeError, 'New service'):
                u.upgrade(self.candidate, 'http://localhost/readyz')
        self.assertEqual(self.binary.read_bytes(), b'old-binary')
        self.assertEqual([c.args for c in service.call_args_list], [('stop',), ('start',), ('stop',), ('start',)])

    def test_start_failure_restores_old_binary(self):
        with patch.object(u, 'systemctl', side_effect=[None, RuntimeError('start'), None, None]), patch.object(u, 'healthy', return_value=True):
            with self.assertRaisesRegex(RuntimeError, 'start'):
                u.upgrade(self.candidate, 'http://localhost/readyz')
        self.assertEqual(self.binary.read_bytes(), b'old-binary')

    def test_stop_failure_keeps_binary_and_restores_service(self):
        with patch.object(u, 'systemctl', side_effect=[RuntimeError('stop'), None]), patch.object(u, 'healthy', return_value=True):
            with self.assertRaisesRegex(RuntimeError, 'stop'):
                u.upgrade(self.candidate, 'http://localhost/readyz')
        self.assertEqual(self.binary.read_bytes(), b'old-binary')

    def test_interrupted_upgrade_rolls_back(self):
        with patch.object(u, 'systemctl', side_effect=[None, KeyboardInterrupt(), None, None]), patch.object(u, 'healthy', return_value=True):
            with self.assertRaises(KeyboardInterrupt):
                u.upgrade(self.candidate, 'http://localhost/readyz')
        self.assertEqual(self.binary.read_bytes(), b'old-binary')

    def test_signal_immediately_after_rename_restores_binary(self):
        real_replace = u.os.replace
        interrupted = False
        def replace(source, target):
            nonlocal interrupted
            real_replace(source, target)
            if target == self.binary and not interrupted:
                interrupted = True
                raise KeyboardInterrupt()
        with patch.object(u.os, 'replace', side_effect=replace), patch.object(u, 'systemctl'), patch.object(u, 'healthy', return_value=True):
            with self.assertRaises(KeyboardInterrupt):
                u.upgrade(self.candidate, 'http://localhost/readyz')
        self.assertEqual(self.binary.read_bytes(), b'old-binary')

    def test_rollback_failure_is_visible(self):
        with patch.object(u, 'systemctl'), patch.object(u, 'healthy', return_value=False):
            with self.assertRaisesRegex(RuntimeError, 'Rollback readiness failed'):
                u.upgrade(self.candidate, 'http://localhost/readyz')
        self.assertEqual(self.binary.read_bytes(), b'old-binary')

    def test_checksum_detects_tamper_missing_and_duplicate(self):
        digest = hashlib.sha256(b'new-binary').hexdigest()
        sums = self.root / 'SHA256SUMS'
        sums.write_text(f'{digest}  candidate\n')
        u.verify(self.root, ['candidate'])
        self.candidate.write_bytes(b'tampered')
        with self.assertRaisesRegex(ValueError, 'mismatch'):
            u.verify(self.root, ['candidate'])
        sums.write_text(f'{digest}  candidate\n{digest}  candidate\n')
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            u.verify(self.root, ['candidate'])
        sums.write_text('')
        with self.assertRaisesRegex(ValueError, 'mismatch'):
            u.verify(self.root, ['candidate'])

    def test_architecture_uses_userspace_bitness(self):
        for machine, bits, expected in [('aarch64', 8, 'arm64'), ('aarch64', 4, 'arm'), ('armv7l', 4, 'arm'), ('x86_64', 8, 'amd64')]:
            with self.subTest(machine=machine, bits=bits), patch.object(u.platform, 'machine', return_value=machine), patch.object(u.struct, 'calcsize', return_value=bits):
                self.assertEqual(u.architecture(), expected)
        with patch.object(u.platform, 'machine', return_value='armv6l'):
            with self.assertRaises(ValueError):
                u.architecture()

    def test_config_is_literal_and_schema_is_read_only(self):
        env = self.root / 'env'
        env.write_text('PARCEL_DATA_DIR="' + str(self.root) + '"\n# comment\nSECRET=\'$(touch /tmp/never)\'\n')
        settings = u.config(env)
        self.assertEqual(settings['SECRET'], '$(touch /tmp/never)')
        with sqlite3.connect(self.root / 'parcel.db') as db:
            db.execute('CREATE TABLE schema_migrations(version INTEGER)')
            db.execute('INSERT INTO schema_migrations VALUES(1)')
        self.assertEqual(u.database_schema(settings), 1)
        with self.assertRaises(ValueError):
            u.database_schema({'PARCEL_DATA_DIR': 'relative'})

    def run_main(self, args, current='0.1.0', target='v0.1.1', auto='true', schema=1, built_version=None, is_active=True, is_healthy=True):
        config_file = self.root / 'parcel.env'
        config_file.write_text('PARCEL_BASE_URL=http://127.0.0.1:8080\n')
        update_file = self.root / 'update.env'
        update_file.write_text(f'PARCEL_AUTO_UPDATE={auto}\n')
        def fake_download(tag, name, dest):
            if name == 'release.json':
                dest.write_text(json.dumps({'version': target[1:], 'schema_version': 1}))
            else:
                dest.write_text('test asset')
        with patch.object(u, 'CONFIG', config_file), patch.object(u, 'UPDATE_CONFIG', update_file), patch.object(u, 'LOCK', self.root / 'lock'), patch.object(u.os, 'geteuid', return_value=0), patch.object(u, 'release', return_value=target) as release, patch.object(u, 'installed_version', return_value=current), patch.object(u, 'active', return_value=is_active), patch.object(u, 'healthy', return_value=is_healthy), patch.object(u, 'architecture', return_value='arm64'), patch.object(u, 'download', side_effect=fake_download) as download, patch.object(u, 'verify'), patch.object(u, 'database_schema', return_value=schema), patch.object(u.subprocess, 'check_output', return_value=built_version or target[1:]), patch.object(u, 'upgrade') as upgrade:
            u.main(args)
            return release.call_count, download.call_count, upgrade.call_count

    def test_main_downloads_verifies_and_upgrades_patch(self):
        self.assertEqual(self.run_main(['--auto']), (1, 3, 1))

    def test_main_auto_disabled_never_contacts_network(self):
        self.assertEqual(self.run_main(['--auto'], auto='false'), (0, 0, 0))

    def test_main_check_and_same_version_do_not_download(self):
        self.assertEqual(self.run_main(['--check']), (1, 0, 0))
        self.assertEqual(self.run_main([], target='v0.1.0'), (1, 0, 0))

    def test_main_auto_skips_downgrades_and_new_minor(self):
        for target in ('v0.0.9', 'v0.2.0', 'v1.0.0'):
            with self.subTest(target=target):
                self.assertEqual(self.run_main(['--auto'], target=target), (1, 0, 0))

    def test_main_manual_allows_explicit_minor_update(self):
        self.assertEqual(self.run_main(['--version', '0.2.0'], target='v0.2.0'), (1, 3, 1))

    def test_main_rejects_schema_migration_and_wrong_binary(self):
        with self.assertRaisesRegex(ValueError, 'Schema-changing'):
            self.run_main([], schema=2)
        with self.assertRaisesRegex(ValueError, 'binary version mismatch'):
            self.run_main([], built_version='0.0.9')

    def test_main_rejects_stopped_or_unhealthy_service(self):
        with self.assertRaisesRegex(ValueError, 'must be running'):
            self.run_main([], is_active=False)
        with self.assertRaisesRegex(ValueError, 'unhealthy'):
            self.run_main([], is_healthy=False)

    def test_release_rejects_prereleases_and_invalid_tags(self):
        for info in ({'tag_name': 'v0.1.1-rc1'}, {'tag_name': 'v0.1.1', 'draft': True}, {'tag_name': 'v0.1.1', 'prerelease': True}):
            with patch.object(u, 'request', return_value=io.BytesIO(json.dumps(info).encode())):
                with self.assertRaises(ValueError):
                    u.release('latest')


if __name__ == '__main__':
    unittest.main()
