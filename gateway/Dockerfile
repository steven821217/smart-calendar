# Gateway 映像：nginx + openssl（首次啟動自簽 TLS）。
FROM nginx:1.27-alpine
RUN apk add --no-cache openssl
COPY gateway/nginx.conf /etc/nginx/conf.d/default.conf
COPY gateway/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 80 443
ENTRYPOINT ["/entrypoint.sh"]
