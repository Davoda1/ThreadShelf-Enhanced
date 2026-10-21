#!/usr/bin/env python3
"""Build reproducible ZIP and TAR.GZ source archives from a committed Git tree.

Usage: python3 scripts/release-source.py --output-dir release [--ref HEAD]
Uncommitted files, local configuration and runtime data are never collected.
"""
import argparse
import datetime
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile
import zipfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', '--output', dest='output', required=True, type=Path)
    parser.add_argument('--ref', default='HEAD')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent

    def git(*arguments):
        return subprocess.check_output(['git', *arguments], cwd=root)

    commit = git('rev-parse', '--verify', '--end-of-options', args.ref + '^{commit}').decode().strip()
    entries = git('ls-tree', '-rz', '--full-tree', commit).split(b'\0')
    paths = {}
    forbidden_roots = {
        'personal', 'private', 'exports', 'DO_NOT_COMMIT', 'node_modules',
        '.local', '.cache', '.config', '.home', '.npm-cache', '.npm-global',
        '.tmp', 'dist', 'public', 'release', 'test-results', 'playwright-report',
    }
    forbidden_anywhere = {'personal', 'private', 'exports', 'DO_NOT_COMMIT',
                          'node_modules', '.local', '.cache', '.home', '.npm-cache',
                          '.npm-global', 'test-results', 'playwright-report'}
    forbidden_suffixes = ('.zip', '.7z', '.tar', '.gz', '.db', '.sqlite', '.sqlite3',
                          '.lance', '.onnx', '.gguf', '.pem', '.key', '.p12', '.log')
    for entry in entries:
        if not entry:
            continue
        metadata, raw_path = entry.split(b'\t', 1)
        mode, kind, _oid = metadata.decode().split()
        path = raw_path.decode('utf-8')
        parts = PurePosixPath(path).parts
        if (not parts or path.startswith('/') or '\\' in path or '..' in parts
                or any(ord(c) < 32 for c in path)
                or parts[0] in forbidden_roots
                or any(p in forbidden_anywhere for p in parts)
                or any(p.startswith(('.threadshelf', '.lancedb', '.uploads', '.migration-stage-')) for p in parts)
                or '.collections.json' in parts
                or any((p == '.env' or p.startswith('.env.')) and path != '.env.example' for p in parts)
                or path.lower().endswith(forbidden_suffixes)):
            raise SystemExit(f'Refusing private, generated or unsafe release path: {path}')
        if kind != 'blob' or mode not in ('100644', '100755'):
            raise SystemExit(f'Refusing non-regular source entry: {path} ({mode})')
        paths[path] = int(mode, 8)

    required = {'package.json', 'package-lock.json', 'README.md', 'LICENSE',
                'THIRD_PARTY_NOTICES.md', '.env.example', 'threadshelf-enhanced',
                'setup-threadshelf.sh', 'setup-threadshelf.ps1'}
    if not required.issubset(paths):
        raise SystemExit('Source tree is missing required release files: ' + ', '.join(sorted(required - paths.keys())))
    contents = {}
    with tarfile.open(fileobj=io.BytesIO(git('archive', '--format=tar', commit))) as archive:
        for member in archive:
            if member.isfile():
                contents[member.name] = archive.extractfile(member).read()
    if contents.keys() != paths.keys():
        raise SystemExit('Git archive contents differ from the reviewed tree (check export attributes).')
    version = json.loads(contents['package.json'])['version']
    if not re.fullmatch(r'\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?', version):
        raise SystemExit('Invalid release version')
    timestamp = int(git('show', '-s', '--format=%ct', commit))
    zip_date = datetime.datetime.fromtimestamp(max(timestamp, 315532800), datetime.timezone.utc).timetuple()[:6]
    prefix = f'ThreadShelf-Enhanced-{version}-Source'
    args.output.mkdir(parents=True, exist_ok=True)
    for extension in ('zip', 'tar.gz'):
        destination = args.output / f'{prefix}.{extension}'
        if extension == 'zip':
            with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
                for path in sorted(paths):
                    info = zipfile.ZipInfo(f'{prefix}/{path}', date_time=zip_date)
                    info.create_system = 3
                    info.external_attr = paths[path] << 16
                    archive.writestr(info, contents[path], compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
        else:
            with destination.open('wb') as output, gzip.GzipFile(fileobj=output, mode='wb', mtime=0, filename='') as compressed:
                with tarfile.open(fileobj=compressed, mode='w', format=tarfile.PAX_FORMAT) as archive:
                    for path in sorted(paths):
                        content = contents[path]
                        info = tarfile.TarInfo(f'{prefix}/{path}')
                        info.size = len(content)
                        info.mtime = timestamp
                        info.mode = paths[path] & 0o777
                        archive.addfile(info, io.BytesIO(content))
        print(json.dumps({'file': str(destination.resolve()), 'commit': commit,
                          'files': len(paths), 'bytes': destination.stat().st_size,
                          'sha256': hashlib.sha256(destination.read_bytes()).hexdigest()}))


if __name__ == '__main__':
    main()
