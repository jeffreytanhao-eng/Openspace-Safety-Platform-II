#!/bin/bash
# Openspace Safety — 部署后主机加固（可重复执行）
# 不修改 /opt/openspace/api/.env 的内容；只调整属主与权限，并确保 API 以 openspace 用户运行。
# TRAE 每次把代码同步到 /opt/openspace 之后都应执行本脚本，再 restart openspace-api。
set -euo pipefail

ROOT=/opt/openspace
API="$ROOT/api"
WEB="$ROOT/web"
DATA="$ROOT/data"
DROPIN_DIR=/etc/systemd/system/openspace-api.service.d
DROPIN="$DROPIN_DIR/hardening.conf"

if [[ ${EUID} -ne 0 ]]; then
  echo "please run as root" >&2
  exit 1
fi

if ! id -u openspace >/dev/null 2>&1; then
  useradd --system --home-dir "$ROOT" --shell /usr/sbin/nologin --comment "Openspace Safety API" openspace
  echo "created system user: openspace"
fi

# 根目录需对 nginx (www-data) 可穿越，切勿再 chmod 777
chmod 755 "$ROOT"
chown root:root "$ROOT"

if [[ -d "$API" ]]; then
  chown -R openspace:openspace "$API"
  find "$API" -type d -exec chmod 750 {} +
  find "$API" -type f -exec chmod 640 {} +
  if [[ -d "$API/node_modules/.bin" ]]; then
    find "$API/node_modules/.bin" -type f -exec chmod 750 {} +
  fi
  if [[ -f "$API/.env" ]]; then
    chown openspace:openspace "$API/.env"
    chmod 640 "$API/.env"
  fi
  chmod 640 "$API"/.env.bak-* 2>/dev/null || true
fi

if [[ -d "$DATA" ]]; then
  chown -R openspace:openspace "$DATA"
  find "$DATA" -type d -exec chmod 750 {} +
  find "$DATA" -type f -exec chmod 640 {} +
fi

if [[ -d "$WEB" ]]; then
  chown -R openspace:www-data "$WEB"
  find "$WEB" -type d -exec chmod 755 {} +
  find "$WEB" -type f -exec chmod 644 {} +
fi

if [[ -d /opt/backup ]]; then
  chown -R root:root /opt/backup
  find /opt/backup -type d -exec chmod 750 {} +
  find /opt/backup -type f -exec chmod 640 {} +
fi

mkdir -p "$DROPIN_DIR"
cat > "$DROPIN" <<'UNIT'
[Service]
User=openspace
Group=openspace
UNIT
chmod 644 "$DROPIN"

systemctl daemon-reload
echo "host hardening applied. next: systemctl restart openspace-api"
