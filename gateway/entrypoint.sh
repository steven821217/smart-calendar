#!/bin/sh
# Gateway 啟動：準備 TLS 憑證後起 nginx。
#
# 三種情形：
#  1) 已掛載真憑證（gateway.crt/gateway.key 已存在且非本腳本自簽）→ 直接使用，不動它。
#     取得真憑證的建議做法：DNS-01 challenge（不需開對外連接埠，A 記錄可指向內網 IP），
#     把憑證檔掛進 /etc/nginx/certs 即可。
#  2) 自簽憑證存在且 SAN 清單未變 → 沿用（避免每次重啟都換憑證，否則已信任的 client 會再跳警告）。
#  3) 沒有憑證，或 SAN 清單變了（例如新增內網 IP）→ 重新自簽。
#
# SAN 一定要包含 client 實際輸入的位址：憑證驗證比對的是 SAN，不是 CN。
# 少了內網 IP，對方用 https://192.168.x.x:9443 連就會驗證失敗。
set -e
CERT_DIR=/etc/nginx/certs
CRT="$CERT_DIR/gateway.crt"
KEY="$CERT_DIR/gateway.key"
SELF_SIGNED_MARKER="$CERT_DIR/.self-signed-san"

mkdir -p "$CERT_DIR"

# 組出 SAN 清單：固定含 localhost/127.0.0.1，再加上 GATEWAY_HOST 與額外指定的位址。
SAN="DNS:localhost,IP:127.0.0.1"
HOST_NAME="${GATEWAY_HOST:-localhost}"
if [ "$HOST_NAME" != "localhost" ]; then
  # GATEWAY_HOST 可能是 IP 或網域，分別歸到 IP: 或 DNS:
  if echo "$HOST_NAME" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
    SAN="$SAN,IP:$HOST_NAME"
  else
    SAN="$SAN,DNS:$HOST_NAME"
  fi
fi
# GATEWAY_SAN_IPS / GATEWAY_SAN_DNS：逗號分隔的額外位址（例如內網 IP、區網主機名）
for ip in $(echo "${GATEWAY_SAN_IPS:-}" | tr ',' ' '); do
  [ -n "$ip" ] && SAN="$SAN,IP:$ip"
done
for d in $(echo "${GATEWAY_SAN_DNS:-}" | tr ',' ' '); do
  [ -n "$d" ] && SAN="$SAN,DNS:$d"
done

# 去重（GATEWAY_HOST 與 GATEWAY_SAN_IPS 可能填同一個位址）
SAN=$(echo "$SAN" | tr ',' '\n' | awk '!seen[$0]++' | paste -sd ',' -)

# 判斷是否需要（重新）自簽。
# 用 openssl 實際比對 issuer 與 subject 來判斷是不是自簽，而不是只看 marker 檔——
# 因為舊版腳本簽出的憑證沒有 marker，只看 marker 會誤判成「使用者掛載的真憑證」而不更新 SAN。
NEED_GEN=0
if [ ! -f "$CRT" ] || [ ! -f "$KEY" ]; then
  NEED_GEN=1
else
  ISSUER=$(openssl x509 -noout -issuer -in "$CRT" 2>/dev/null | sed 's/^issuer=//')
  SUBJECT=$(openssl x509 -noout -subject -in "$CRT" 2>/dev/null | sed 's/^subject=//')
  if [ -n "$ISSUER" ] && [ "$ISSUER" = "$SUBJECT" ]; then
    # 自簽憑證：SAN 清單與需求不符就重簽
    CURRENT_SAN=""
    [ -f "$SELF_SIGNED_MARKER" ] && CURRENT_SAN=$(cat "$SELF_SIGNED_MARKER")
    if [ "$CURRENT_SAN" != "$SAN" ]; then
      echo "[gateway] self-signed cert SAN differs from required set, regenerating"
      NEED_GEN=1
    fi
  else
    # issuer != subject → 由真正的 CA 簽發，絕不覆蓋
    echo "[gateway] using CA-issued certificate (issuer: ${ISSUER:-unknown}); leaving it untouched"
  fi
fi

if [ "$NEED_GEN" = "1" ]; then
  echo "[gateway] generating self-signed TLS cert (CN=${HOST_NAME}, SAN=${SAN})"
  openssl req -x509 -nodes -newkey rsa:2048 -days 365 \
    -keyout "$KEY" -out "$CRT" \
    -subj "/CN=${HOST_NAME}" \
    -addext "subjectAltName=${SAN}"
  printf '%s' "$SAN" > "$SELF_SIGNED_MARKER"
fi

exec nginx -g 'daemon off;'
