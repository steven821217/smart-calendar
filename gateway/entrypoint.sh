#!/bin/sh
# 首次啟動自簽 TLS 憑證（正式環境改掛真憑證：把 /etc/nginx/certs 換成掛載的真憑證即可）。
set -e
CERT_DIR=/etc/nginx/certs
CRT="$CERT_DIR/gateway.crt"
KEY="$CERT_DIR/gateway.key"

mkdir -p "$CERT_DIR"
if [ ! -f "$CRT" ] || [ ! -f "$KEY" ]; then
  echo "[gateway] generating self-signed TLS cert (CN=${GATEWAY_HOST:-localhost})"
  openssl req -x509 -nodes -newkey rsa:2048 -days 365 \
    -keyout "$KEY" -out "$CRT" \
    -subj "/CN=${GATEWAY_HOST:-localhost}" \
    -addext "subjectAltName=DNS:localhost,DNS:${GATEWAY_HOST:-localhost},IP:127.0.0.1"
fi

exec nginx -g 'daemon off;'
