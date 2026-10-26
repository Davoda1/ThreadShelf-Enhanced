#!/usr/bin/env python3
"""Exercise the real source packager against isolated, synthetic Git repositories.

Run with: python test/source-release.test.py
Only Python's standard library and Git are required. No real project data, Git
configuration, installed dependencies, or network access is used by these tests.
"""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile


PACKAGER = Path(__file__).resolve().parents[1] / 'scripts' / 'release-source.py'
PREFIX = 'ThreadShelf-Enhanced-1.0.0-Source'
EXECUTABLES = ('threadshelf-enhanced', 'setup-threadshelf.sh')


class SourceReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='threadshelf-source-tests-')
        self.addCleanup(self.temporary.cleanup)
        self.workspace = Path(self.temporary.name)
        self.repo = self.workspace / 'repo'
        self.repo.mkdir()
        self.env = os.environ.copy()
        for key in ('GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR'):
            self.env.pop(key, None)
        self.env.update({
            'GIT_CONFIG_GLOBAL': os.devnull,
            'GIT_CONFIG_SYSTEM': os.devnull,
            'GIT_CONFIG_NOSYSTEM': '1',
            'GIT_AUTHOR_DATE': '2026-01-02T03:04:06+00:00',
            'GIT_COMMITTER_DATE': '2026-01-02T03:04:06+00:00',
        })
        self.git('-c', 'init.defaultBranch=master', 'init', '--quiet')
        self.git('config', 'user.name', 'Source Package Tests')
        self.git('config', 'user.email', 'source-tests@example.invalid')
        self.git('config', 'core.autocrlf', 'false')
        self.git('config', 'core.filemode', 'false')
        self.git('config', 'commit.gpgsign', 'false')
        files = {
            '.gitattributes': b'* -text\n',
            '.env.example': b'HOST=127.0.0.1\nPORT=3000\n',
            'package.json': b'{"name":"synthetic-package","version":"1.0.0","private":true}\n',
            'package-lock.json': b'{"lockfileVersion":3,"packages":{}}\n',
            'README.md': b'Synthetic committed source fixture.\n',
            'LICENSE': b'Synthetic license text; preserve these CRLF bytes.\r\n',
            'THIRD_PARTY_NOTICES.md': b'Synthetic dependency notice.\n',
            'threadshelf-enhanced': b'#!/usr/bin/env bash\nprintf "synthetic launcher\\n"\n',
            'setup-threadshelf.sh': b'#!/usr/bin/env bash\nexit 0\n',
            'setup-threadshelf.ps1': b'Write-Output "synthetic setup"\n',
            'client/public/renderer/synthetic.js': b'// Synthetic bundled renderer.\n',
            'docs/release notes.txt': 'Synthetic Unicode: λ.\n'.encode(),
            'test/fixtures/binary.bin': b'\x00\x01\xff\r\n',
            'scripts/release-source.py': PACKAGER.read_bytes(),
        }
        for path, content in files.items():
            self.write(path, content)
        self.base_commit = self.commit('Create synthetic source fixture')

    def git(self, *arguments, input_bytes=None):
        result = subprocess.run(
            ['git', *arguments], cwd=self.repo, env=self.env,
            input=input_bytes, capture_output=True, timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors='replace'))
        return result.stdout

    def write(self, path, content):
        destination = self.repo / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(content)

    def commit(self, message, stage=True):
        if stage:
            self.git('add', '--all')
            # Index permissions are portable even without POSIX filesystem modes.
            for path in EXECUTABLES:
                if (self.repo / path).exists():
                    self.git('update-index', '--chmod=+x', path)
        self.git('commit', '--quiet', '-m', message)
        return self.git('rev-parse', 'HEAD').decode().strip()

    def package(self, output_name='output', ref='HEAD', success=True):
        output = self.workspace / output_name
        existing_paths = set(output.iterdir()) if output.is_dir() else set()
        result = subprocess.run(
            [sys.executable, str(self.repo / 'scripts/release-source.py'),
             '--output-dir', str(output), '--ref', ref],
            # Verify that packaging does not depend on the caller's directory.
            cwd=self.workspace, env=self.env, capture_output=True, text=True,
            timeout=30,
        )
        if not success:
            self.assertNotEqual(result.returncode, 0, result.stdout)
            self.assertTrue(result.stderr.strip(), 'Rejected input needs a diagnostic')
            self.assertEqual(set(output.iterdir()) if output.is_dir() else set(), existing_paths,
                             'A rejected tree must not emit partial release files')
            return result
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual({path.name for path in output.iterdir()},
                         {PREFIX + '.zip', PREFIX + '.tar.gz', 'SHA256SUM.txt'})
        reports = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(len(reports), 2)
        for report in reports:
            path = Path(report['file'])
            # Windows TEMP may use a DOS short name while the packager reports
            # the resolved long name; compare directory identity, not spelling.
            self.assertTrue(path.parent.samefile(output))
            self.assertEqual(report['bytes'], path.stat().st_size)
            self.assertEqual(report['sha256'], hashlib.sha256(path.read_bytes()).hexdigest())
        return output, reports

    def committed_files(self, ref='HEAD'):
        result = {}
        for entry in self.git('ls-tree', '-rz', '--full-tree', ref).split(b'\0'):
            if not entry:
                continue
            metadata, raw_path = entry.split(b'\t', 1)
            mode, kind, object_id = metadata.decode().split()
            self.assertEqual(kind, 'blob')
            path = raw_path.decode()
            result[path] = (self.git('cat-file', 'blob', object_id), int(mode, 8) & 0o777)
        return result

    def archive_files(self, path):
        result = {}

        def source_name(name):
            self.assertTrue(name.startswith(PREFIX + '/'), name)
            relative = name[len(PREFIX) + 1:]
            self.assertTrue(relative)
            self.assertFalse(PurePosixPath(relative).is_absolute())
            self.assertNotIn('..', PurePosixPath(relative).parts)
            self.assertNotIn(relative, result, 'Duplicate archive member')
            return relative

        if path.suffix == '.zip':
            with zipfile.ZipFile(path) as archive:
                for member in archive.infolist():
                    self.assertFalse(member.is_dir())
                    mode = member.external_attr >> 16
                    self.assertTrue(stat.S_ISREG(mode), member.filename)
                    result[source_name(member.filename)] = (archive.read(member), mode & 0o777)
        else:
            with tarfile.open(path, 'r:gz') as archive:
                for member in archive:
                    self.assertTrue(member.isfile(), member.name)
                    self.assertEqual((member.uid, member.gid), (0, 0))
                    self.assertEqual((member.uname, member.gname), ('', ''))
                    result[source_name(member.name)] = (archive.extractfile(member).read(), member.mode)
        return result

    def assert_archives_match_commit(self, output, ref='HEAD'):
        expected = self.committed_files(ref)
        for path in output.iterdir():
            if path.name == 'SHA256SUM.txt':
                continue
            with self.subTest(archive=path.name):
                self.assertEqual(self.archive_files(path), expected)

    def test_archives_match_committed_bytes_paths_and_executable_permissions(self):
        output, reports = self.package()
        self.assert_archives_match_commit(output)
        expected_count = len(self.committed_files())
        for report in reports:
            self.assertEqual(report['commit'], self.base_commit)
            self.assertEqual(report['files'], expected_count)
        for path in output.iterdir():
            if path.name == 'SHA256SUM.txt':
                continue
            contents = self.archive_files(path)
            for executable in EXECUTABLES:
                self.assertEqual(contents[executable][1], 0o755)
            self.assertEqual(contents['README.md'][1], 0o644)
            self.assertEqual(contents['LICENSE'][0].count(b'\r\n'), 1)
            self.assertIn('client/public/renderer/synthetic.js', contents)

    def test_repeated_builds_are_byte_identical(self):
        first, _ = self.package('first')
        second, _ = self.package('second')
        for path in first.iterdir():
            self.assertEqual(path.read_bytes(), (second / path.name).read_bytes())

    def test_one_consolidated_checksum_file_covers_only_the_two_archives(self):
        output, _ = self.package()
        names = sorted((PREFIX + '.zip', PREFIX + '.tar.gz'))
        expected = ''.join(hashlib.sha256((output / name).read_bytes()).hexdigest()
                           + '  ' + name + '\n' for name in names).encode('ascii')
        self.assertEqual((output / 'SHA256SUM.txt').read_bytes(), expected)
        for name in names:
            self.assertNotIn('SHA256SUM.txt', self.archive_files(output / name))

    def test_untracked_configuration_personal_files_and_dependencies_are_excluded(self):
        for path in ('.env', 'personal/threadShelf-enhanced', 'private/settings.txt',
                     'client/node_modules/synthetic/index.js', '.uploads/source.json'):
            self.write(path, b'Synthetic untracked content.\n')
        output, _ = self.package()
        self.assert_archives_match_commit(output)

    def test_dirty_staged_and_missing_working_files_do_not_change_archives(self):
        self.write('README.md', b'Uncommitted replacement.\n')
        self.write('package.json', b'{"version":"9.9.9"}\n')
        self.write('.env', b'SYNTHETIC_SETTING=not-for-release\n')
        self.git('add', '.env', 'README.md', 'package.json')
        (self.repo / 'LICENSE').unlink()
        output, reports = self.package()
        self.assert_archives_match_commit(output, self.base_commit)
        self.assertTrue(all(report['commit'] == self.base_commit for report in reports))

    def test_explicit_ref_uses_that_commits_source_and_version(self):
        self.write('README.md', b'Later committed source.\n')
        self.write('package.json', b'{"version":"9.9.9"}\n')
        self.commit('Create a later version')
        output, reports = self.package(ref=self.base_commit)
        self.assert_archives_match_commit(output, self.base_commit)
        self.assertTrue(all(report['commit'] == self.base_commit for report in reports))

    def test_committed_private_runtime_and_nested_dependency_paths_are_rejected(self):
        cases = (
            '.env', '.env.local', '.collections.json', 'personal/launcher',
            'nested/private/settings.txt', 'client/node_modules/synthetic/index.js',
            '.local/runtime/node', '.lancedb/archive/data.txt', '.uploads/source.json',
            '.threadshelf/model-cache/weights.bin', '.migration-stage-test/state.txt',
            'dist/server.js', 'public/index.html', 'release/artifact.txt',
            '.ENV', 'nested/.ENV.LOCAL', 'Personal/launcher', 'nested/PRIVATE/state.txt',
            '.THREADSHELF/image-cache/image.bin', '.tmp-staging/state.txt', 'SHA256SUM.txt',
        )
        for index, path in enumerate(cases):
            with self.subTest(path=path):
                self.git('reset', '--hard', '--quiet', self.base_commit)
                self.write(path, b'Synthetic forbidden committed file.\n')
                self.commit('Add a forbidden fixture')
                self.package(output_name='rejected-' + str(index), success=False)

    def test_committed_generated_archives_databases_and_keys_are_rejected(self):
        for index, path in enumerate(('backup.zip', 'model.onnx', 'archive.sqlite3', 'server.key',
                                      'registry.lock.sqlite-journal', 'registry.lock.sqlite-wal',
                                      'registry.lock.sqlite-shm')):
            with self.subTest(path=path):
                self.git('reset', '--hard', '--quiet', self.base_commit)
                self.write(path, b'Synthetic forbidden bytes.\n')
                self.commit('Add a generated fixture')
                self.package(output_name='rejected-' + str(index), success=False)

    def test_committed_symlink_is_rejected_without_requiring_os_symlink_privileges(self):
        object_id = self.git('hash-object', '-w', '--stdin', input_bytes=b'README.md').decode().strip()
        self.git('update-index', '--add', '--cacheinfo', '120000,' + object_id + ',source-link')
        self.commit('Add a synthetic symlink', stage=False)
        self.assertTrue(self.git('ls-tree', 'HEAD', 'source-link').startswith(b'120000 blob'))
        self.package(success=False)

    def test_committed_submodule_is_rejected(self):
        self.git('update-index', '--add', '--cacheinfo', '160000,' + self.base_commit + ',vendor/external')
        self.commit('Add a synthetic gitlink', stage=False)
        self.package(success=False)

    def test_required_license_and_notice_files_cannot_be_omitted(self):
        for index, path in enumerate(('LICENSE', 'THIRD_PARTY_NOTICES.md')):
            with self.subTest(path=path):
                self.git('reset', '--hard', '--quiet', self.base_commit)
                self.git('rm', '--quiet', path)
                self.commit('Remove a required notice')
                self.package(output_name='rejected-' + str(index), success=False)

    def test_export_attributes_cannot_silently_remove_committed_source(self):
        self.write('.gitattributes', b'* -text\nREADME.md export-ignore\n')
        self.commit('Hide source from git archive')
        self.package(success=False)

    def test_export_substitution_cannot_change_committed_bytes(self):
        self.write('.gitattributes', b'* -text\nREADME.md export-subst\n')
        self.write('README.md', b'Commit metadata must remain literal: $Format:%H %an %ae$\n')
        self.commit('Mark a synthetic source file for substitution')
        result = self.package(success=False)
        self.assertIn('changed committed source bytes', result.stderr)

    def test_windows_unsafe_path_is_rejected_from_a_git_tree(self):
        # Build the tree directly so this test also runs on Windows, where a
        # colon is not a portable working-tree filename.
        blob = self.git('hash-object', '-w', '--stdin', input_bytes=b'Synthetic bytes.\n').strip()
        entries = self.git('ls-tree', '-z', 'HEAD')
        tree = self.git('mktree', '-z', input_bytes=entries + b'100644 blob ' + blob
                        + b'\tunsafe:stream\0').decode().strip()
        commit = self.git('commit-tree', tree, '-p', self.base_commit,
                          input_bytes=b'Create synthetic unsafe source tree\n').decode().strip()
        self.package(ref=commit, success=False)

    def test_symlinked_artifact_target_cannot_overwrite_an_unrelated_file(self):
        output = self.workspace / 'symlink-output'
        output.mkdir()
        target = self.workspace / 'unrelated-file.txt'
        original = b'Unrelated synthetic bytes must not change.\n'
        target.write_bytes(original)
        for name in (PREFIX + '.zip', PREFIX + '.tar.gz', 'SHA256SUM.txt'):
            link = output / name
            try:
                link.symlink_to(target)
            except OSError as error:
                self.skipTest(f'Operating system does not permit symbolic links: {error}')
            with self.subTest(target=name):
                result = self.package(output_name='symlink-output', success=False)
                self.assertIn('symlinked release output file', result.stderr)
                self.assertEqual(target.read_bytes(), original)
            link.unlink()

    def test_symlinked_output_directory_is_rejected(self):
        target = self.workspace / 'unrelated-directory'
        target.mkdir()
        output = self.workspace / 'symlink-directory'
        try:
            output.symlink_to(target, target_is_directory=True)
        except OSError as error:
            self.skipTest(f'Operating system does not permit symbolic links: {error}')
        result = self.package(output_name='symlink-directory', success=False)
        self.assertIn('symlinked release output directory', result.stderr)

    def test_invalid_ref_and_unsafe_version_produce_no_archives(self):
        self.package(output_name='bad-ref', ref='missing-synthetic-ref', success=False)
        self.write('package.json', b'{"version":"../outside"}\n')
        self.commit('Set an unsafe version')
        self.package(output_name='bad-version', success=False)


if __name__ == '__main__':
    if shutil.which('git') is None:
        raise SystemExit('Git is required to test source packaging.')
    unittest.main(verbosity=2)
