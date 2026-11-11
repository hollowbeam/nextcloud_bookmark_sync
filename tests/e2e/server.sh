#!/usr/bin/env bash
# Starts (or stops) the Nextcloud used by the end-to-end tests, behind an HTTPS gzip proxy.
#   tests/e2e/server.sh start   -> https://localhost:8443, user admin / e2e-test-pass
#   tests/e2e/server.sh stop    -> removes the containers, their volumes and the network
set -euo pipefail

NC_IMAGE="nextcloud:31-apache"
CADDY_IMAGE="caddy:2"
DIR="$(cd "$(dirname "$0")" && pwd)"
DAV="https://localhost:8443/remote.php/dav/files/admin"
AUTH="admin:e2e-test-pass"

stop() {
    docker rm -f -v nbs-nc nbs-caddy >/dev/null 2>&1 || true
    docker network rm nbs-e2e >/dev/null 2>&1 || true
}

start() {
    stop
    docker network create nbs-e2e >/dev/null
    docker run -d --name nbs-nc --network nbs-e2e --network-alias nc \
        -e SQLITE_DATABASE=nc -e NEXTCLOUD_ADMIN_USER=admin -e NEXTCLOUD_ADMIN_PASSWORD=e2e-test-pass \
        -e NEXTCLOUD_TRUSTED_DOMAINS="localhost nc" -e OVERWRITEPROTOCOL=https \
        "$NC_IMAGE" >/dev/null

    # Git Bash on Windows needs a Windows path for the bind mount
    local caddyfile="$DIR/Caddyfile"
    if command -v cygpath >/dev/null 2>&1; then caddyfile="$(cygpath -w "$caddyfile")"; fi
    docker run -d --name nbs-caddy --network nbs-e2e -p 8443:8443 \
        -v "$caddyfile:/etc/caddy/Caddyfile" "$CADDY_IMAGE" >/dev/null

    # The first start installs Nextcloud: up to a few minutes
    for _ in $(seq 1 90); do
        status=$(curl -sk -o /dev/null -w '%{http_code}' -u "$AUTH" -X PROPFIND "$DAV/" || true)
        if [ "$status" = "207" ]; then break; fi
        sleep 4
    done
    if [ "$status" != "207" ]; then
        echo "Nextcloud did not start (last status: $status)" >&2
        docker logs --tail 30 nbs-nc >&2 || true
        exit 1
    fi

    for folder in bookmarks-test bookmarks-a; do
        curl -sk -o /dev/null -u "$AUTH" -X MKCOL "$DAV/$folder/"
    done
    echo "Nextcloud ready on https://localhost:8443"
}

case "${1:-}" in
    start) start ;;
    stop) stop ;;
    *) echo "usage: $0 start|stop" >&2; exit 2 ;;
esac
