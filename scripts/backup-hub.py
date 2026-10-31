#!/usr/bin/env python3
"""Private, verified hub snapshots. Agent execution evidence is backed up separately."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import stat
import subprocess
import tempfile
import time


def files(root):
    for item in sorted(root.rglob('*')):
        mode = item.lstat().st_mode
        if stat.S_ISLNK(mode) or not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
            raise ValueError('Snapshot contains a link or special file')
        if stat.S_ISREG(mode):
            yield item


def digest(file):
    with file.open('rb') as stream:
        checksum = hashlib.sha256()
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            checksum.update(block)
        return checksum.hexdigest()


def verify(snapshot):
    snapshot = Path(snapshot).resolve(strict=True)
    actual = {str(p.relative_to(snapshot)) for p in files(snapshot)}
    manifest = json.loads((snapshot / 'manifest.json').read_text())
    expected = manifest['files']
    if manifest.get('format') != 1 or actual != set(expected) | {'manifest.json'}:
        raise ValueError('Snapshot inventory does not match manifest')
    for name, checksum in expected.items():
        if digest(snapshot / name) != checksum:
            raise ValueError('Snapshot checksum mismatch')
    for name in ('hub.json', 'admin.token', 'hub.sqlite', 'accounts.sqlite', 'oauth.sqlite', 'oauth.key'):
        if name not in expected:
            raise ValueError('Required hub state is missing')
    if any(name.endswith(('.sqlite-wal', '.sqlite-shm')) for name in expected):
        raise ValueError('Snapshot databases must be checkpointed')
    databases = 0
    for name in expected:
        if name.endswith('.sqlite'):
            connection = sqlite3.connect((snapshot / name).as_uri() + '?mode=ro&immutable=1', uri=True)
            try:
                if connection.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                    raise ValueError('SQLite integrity check failed')
            finally:
                connection.close()
            databases += 1
    return {'ok': True, 'files': len(expected), 'databases': databases}


def snapshot(state, destination, service=None, offline=False):
    state = Path(state).resolve(strict=True)
    destination = Path(destination).resolve()
    if state == destination or state in destination.parents or destination in state.parents:
        raise ValueError('State and backup directories must be separate')
    if not service and not offline:
        raise ValueError('Specify the hub service, or explicitly confirm offline state')
    if service and (offline or service != 'comand-hub-' + hashlib.sha256(str(state).encode()).hexdigest()[:8] + '.service'):
        raise ValueError('Service must match this hub state directory')
    destination.mkdir(mode=0o700, parents=True, exist_ok=True)
    if destination.stat().st_uid != os.getuid() or destination.stat().st_mode & 0o077:
        raise ValueError('Backup destination must be owned by this user with mode 0700')
    lockfd = os.open(destination / '.backup.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lockfd, 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        def manager(*args):
            return subprocess.run(['systemctl', '--user', *args], check=True, capture_output=True, text=True, timeout=45).stdout.strip()
        restart = False
        temporary = None
        try:
            if service:
                active = manager('show', '--property=ActiveState', '--value', service)
                if active not in ('active', 'inactive'):
                    raise ValueError('Hub service is not in a stable state')
                restart = active == 'active'
                manager('stop', service)
                if manager('show', '--property=ActiveState', '--value', service) != 'inactive':
                    raise ValueError('Hub service did not stop')
            temporary = Path(tempfile.mkdtemp(prefix='.partial-', dir=destination))
            for source in files(state):
                if source.relative_to(state).as_posix() == 'manifest.json':
                    continue  # Snapshot metadata left by a previous restore is not hub state.
                target = temporary / source.relative_to(state)
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                shutil.copyfile(source, target, follow_symlinks=False)
                target.chmod(0o600)
            # Normalize only the private copy, including a surviving WAL after a crash.
            for database in list(temporary.rglob('*.sqlite')):
                connection = sqlite3.connect(database)
                try:
                    if connection.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()[0] != 0:
                        raise ValueError('Copied database could not be checkpointed')
                finally:
                    connection.close()
                for suffix in ('-wal', '-shm'):
                    Path(str(database) + suffix).unlink(missing_ok=True)
            manifest = {'format': 1, 'createdAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'files': {str(p.relative_to(temporary)): digest(p) for p in files(temporary)}}
            (temporary / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
            (temporary / 'manifest.json').chmod(0o600)
            result = verify(temporary)
            for file in files(temporary):
                with file.open('rb') as stream:
                    os.fsync(stream.fileno())
            for directory in [*sorted((p for p in temporary.rglob('*') if p.is_dir()), key=lambda p: len(p.parts), reverse=True), temporary]:
                descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
            final = destination / ('hub-' + time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + temporary.name[-8:])
            temporary.rename(final)
            temporary = None
            descriptor = os.open(destination, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
            return {**result, 'snapshot': str(final)}
        finally:
            try:
                if restart:
                    manager('start', service)
                    if manager('show', '--property=ActiveState', '--value', service) != 'active':
                        raise RuntimeError('Hub did not restart after backup; inspect its service')
            finally:
                if temporary:
                    shutil.rmtree(temporary)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--verify')
    parser.add_argument('--state')
    parser.add_argument('--destination')
    parser.add_argument('--service')
    parser.add_argument('--offline', action='store_true', help='Hub is already stopped; never use for a running hub')
    args = parser.parse_args()
    if args.verify:
        result = verify(args.verify)
    else:
        if not args.state or not args.destination:
            parser.error('--state and --destination are required')
        result = snapshot(args.state, args.destination, args.service, args.offline)
    print(json.dumps(result))


if __name__ == '__main__':
    main()
