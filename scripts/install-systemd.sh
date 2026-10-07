#!/usr/bin/env bash
# Installs files but does not initialize a password, alter the firewall or start the service.
set -euo pipefail
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
[[ "$EUID" == 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
[[ -f "$task_root/bin/parcel" ]] || { echo 'Run scripts/build.sh first.' >&2; exit 1; }
getent passwd parcel >/dev/null || useradd --system --home-dir /srv/parcel --shell /usr/sbin/nologin parcel
install -d -m 0755 /opt/parcel
install -d -m 0700 /etc/parcel
install -d -m 0700 -o parcel -g parcel /srv/parcel
if [[ -f /opt/parcel/parcel ]]; then
  systemctl is-active --quiet parcel && { echo 'Stop parcel before upgrading.' >&2; exit 1; }
  cp -- /opt/parcel/parcel /opt/parcel/parcel.previous
fi
install -m 0755 "$task_root/bin/parcel" /opt/parcel/parcel
[[ -f /etc/parcel/parcel.env ]] || install -m 0600 "$task_root/deploy/parcel.env.example" /etc/parcel/parcel.env
install -m 0644 "$task_root/deploy/systemd/parcel.service" /etc/systemd/system/parcel.service
systemctl daemon-reload
echo 'Installed. Review /etc/parcel/parcel.env, initialize admin-password, then enable --now parcel.'
