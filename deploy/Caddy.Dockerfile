# syntax=docker/dockerfile:1
ARG CADDY_IMAGE=caddy:2.11.7-alpine
FROM ${CADDY_IMAGE}
# Listen on unprivileged internal ports; Compose maps public 80/443 to them.
# Drop inherited file capabilities so execution also works with cap_drop: ALL.
# Inspect first: setcap -r fails when the capability attribute is already absent.
RUN set -eu; \
    file_caps="$(getcap /usr/bin/caddy)"; \
    if [ -n "$file_caps" ]; then setcap -r /usr/bin/caddy; fi; \
    mkdir -p /data /config; \
    chown -R 1000:1000 /data /config
COPY deploy/Caddyfile /etc/caddy/Caddyfile.domain
COPY deploy/Caddyfile.ip /etc/caddy/Caddyfile.ip
USER 1000:1000
EXPOSE 8080 8443
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile.domain", "--adapter", "caddyfile"]
