#!/bin/bash
# Run as root from a reviewed, pinned checkout on a new Debian 13 VM.
# Never put credentials in VM metadata, startup logs, or Git.
set -euo pipefail
umask 077
test "$(id -u)" = 0 || { echo 'Run as root.' >&2; exit 1; }
. /etc/os-release
test "$ID" = debian && test "$VERSION_ID" = 13 || {
  echo 'This bootstrap targets Debian 13 only.' >&2; exit 1;
}
deploy_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
test "$deploy_dir" = /opt/finch-newsletter/deploy/finch || {
  echo 'Use /opt/finch-newsletter as the checkout location.' >&2; exit 1;
}
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y docker.io docker-compose openssl ca-certificates unattended-upgrades
# Give the 2 GB host room for occasional installation/restart memory spikes.
# The swap file is on the encrypted boot disk and is readable only by root.
if test ! -e /swapfile; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
fi
if ! swapon --show=NAME --noheadings | grep -Fxq /swapfile; then
  swapon /swapfile
fi
if ! grep -Eq '^/swapfile[[:space:]]' /etc/fstab; then
  printf '%s\n' '/swapfile none swap sw 0 0' >> /etc/fstab
fi
install -d -m 755 /etc/docker
if test ! -e /etc/docker/daemon.json; then
  printf '%s\n' '{"log-driver":"local","log-opts":{"max-size":"10m","max-file":"3"}}' > /etc/docker/daemon.json
  systemctl restart docker
fi
systemctl enable --now docker
cd "$deploy_dir"
if test ! -e .env; then
  # Values contain only hex characters, so Compose interpolation is unambiguous.
  db_secret="$(openssl rand -hex 32)"
  admin_secret="$(openssl rand -hex 32)"
  {
    printf '%s\n' 'NEWSLETTER_DOMAIN=newsletter.finchnow.com'
    printf 'POSTGRES_PASSWORD=%s\n' "$db_secret"
    printf '%s\n' 'LISTMONK_ADMIN_USER=finch-admin'
    printf 'LISTMONK_ADMIN_PASSWORD=%s\n' "$admin_secret"
  } > .env.initial
  chmod 600 .env.initial
  mv .env.initial .env
  unset db_secret admin_secret
fi
test -f .env && test ! -L .env
chown root:root .env
chmod 600 .env
docker compose config --quiet
docker compose pull
docker compose up -d --wait --wait-timeout 240 db app
# HTTPS certificate acquisition follows DNS cutover. No database or API ports
# are published; listmonk has its administrator credential before public access.
docker compose up -d caddy
install -d -m 700 /var/backups/finch-newsletter
cat > /etc/systemd/system/finch-newsletter-backup.service <<'EOF'
[Unit]
Description=Private Finch newsletter database and uploads backup
Requires=docker.service
After=docker.service
[Service]
Type=oneshot
UMask=0077
WorkingDirectory=/opt/finch-newsletter/deploy/finch
ExecStart=/bin/sh /opt/finch-newsletter/deploy/finch/backup.sh /var/backups/finch-newsletter
EOF
cat > /etc/systemd/system/finch-newsletter-backup.timer <<'EOF'
[Unit]
Description=Daily Finch newsletter backup
[Timer]
OnCalendar=*-*-* 04:15:00 UTC
RandomizedDelaySec=900
Persistent=true
[Install]
WantedBy=timers.target
EOF
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
systemctl daemon-reload
systemctl enable --now finch-newsletter-backup.timer
systemctl start finch-newsletter-backup.service
# Local backups need an off-host copy and a tested restore before migration.
# No automatic pruning is enabled until off-host recovery has been verified.
echo 'Finch newsletter started. Credentials are in root-owned deploy/finch/.env.'
echo 'Configure root URL, SES, off-host backups, and OAuth before importing or sending.'
