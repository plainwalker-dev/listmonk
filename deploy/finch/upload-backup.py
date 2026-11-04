#!/usr/bin/env python3
"""Add immutable backup objects using the VM's bucket-scoped identity.

The identity needs storage.objects.create only. No credential is saved locally.
Run after backup.sh; an upload failure leaves the local backups intact.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import urllib.parse
import urllib.request


def main():
    bucket = os.environ.get('BACKUP_BUCKET', '')
    if not re.fullmatch(r'[a-z0-9][a-z0-9.-]{1,220}[a-z0-9]', bucket):
        raise RuntimeError('Set BACKUP_BUCKET to the approved private bucket.')
    directory = Path('/var/backups/finch-newsletter')
    dumps = sorted(directory.glob('listmonk-*.dump'))
    if not dumps:
        raise RuntimeError('No complete database backup found.')
    database = dumps[-1]
    stamp = database.name.removeprefix('listmonk-').removesuffix('.dump')
    if not re.fullmatch(r'\d{8}T\d{6}Z', stamp):
        raise RuntimeError('Unexpected backup filename.')
    uploads = directory / f'uploads-{stamp}.tar.gz'
    if not uploads.is_file():
        raise RuntimeError('Matching uploads backup is missing.')
    token_request = urllib.request.Request(
        'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
        headers={'Metadata-Flavor': 'Google'})
    with urllib.request.urlopen(token_request, timeout=10) as response:
        token = json.load(response)['access_token']
    results = []
    for source in (database, uploads):
        if source.is_symlink() or source.resolve().parent != directory.resolve():
            raise RuntimeError('Unexpected backup location.')
        digest = hashlib.md5(usedforsecurity=False)
        with source.open('rb') as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(chunk)
        expected_md5 = base64.b64encode(digest.digest()).decode()
        # Unique names + a generation precondition prevent replacing an object.
        # After a partial upload, run backup.sh again to create a fresh pair.
        # Existing remote objects are never overwritten.
        object_name = f'daily/{stamp}/{source.name}'
        query = urllib.parse.urlencode({'uploadType': 'media', 'name': object_name,
                                       'ifGenerationMatch': '0'})
        url = f'https://storage.googleapis.com/upload/storage/v1/b/{bucket}/o?{query}'
        with source.open('rb') as stream:
            request = urllib.request.Request(url, data=stream, method='POST', headers={
                'Authorization': 'Bearer ' + token,
                'Content-Type': 'application/octet-stream',
                'Content-Length': str(source.stat().st_size),
            })
            with urllib.request.urlopen(request, timeout=120) as response:
                metadata = json.load(response)
        if metadata.get('md5Hash') != expected_md5 or int(metadata.get('size', -1)) != source.stat().st_size:
            raise RuntimeError('Remote backup checksum or size mismatch.')
        results.append({'object': object_name, 'md5': expected_md5,
                        'bytes': source.stat().st_size})
    result = {'uploaded': True, 'bucket': bucket, 'backup_time': stamp, 'files': results}
    receipt = directory / 'offsite-last-success.json'
    receipt.write_text(json.dumps(result))
    receipt.chmod(0o600)
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        # HTTP exceptions include only a status/URL; never print token or headers.
        print(f'Off-server backup failed: {exc}', file=sys.stderr)
        raise SystemExit(1) from None
