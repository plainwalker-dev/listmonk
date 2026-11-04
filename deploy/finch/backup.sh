#!/usr/bin/env sh
set -eu
# Run in deploy/finch. The destination should be a private, backed-up volume.
backup_dir="${1:?Usage: backup.sh /absolute/private/backup-directory}"
case "$backup_dir" in /*) ;; *) echo 'Use an absolute backup directory.' >&2; exit 1;; esac
umask 077
mkdir -p "$backup_dir"
backup_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
db_tmp="$backup_dir/listmonk-$backup_stamp.dump.partial"
docker compose exec -T db pg_dump -U listmonk -d listmonk -Fc > "$db_tmp"
test -s "$db_tmp"
mv "$db_tmp" "$backup_dir/listmonk-$backup_stamp.dump"
docker compose run --rm --no-deps -T --entrypoint tar app -czf - -C /listmonk uploads > "$backup_dir/uploads-$backup_stamp.tar.gz.partial"
test -s "$backup_dir/uploads-$backup_stamp.tar.gz.partial"
mv "$backup_dir/uploads-$backup_stamp.tar.gz.partial" "$backup_dir/uploads-$backup_stamp.tar.gz"
echo "Database and uploads backed up at $backup_stamp."
