#!/bin/bash
# Fork-only, copied from prefect-remote. Points the Unraid Seerr container at a
# published image tag and applies it, from this Mac, without your WireGuard
# being on: a throwaway container joins WireGuard as its own peer and SSHes to
# Unraid, where scripts/unraid-deploy.sh does the work.
#
#   scripts/deploy-unraid.sh            # newest published tag
#   scripts/deploy-unraid.sh v1.0.0     # a specific tag (rollback)
#
# Needs Docker Desktop and, in ~/.config/unraid-deploy-seerr/:
#   wg0.conf      WireGuard peer (shared with prefect-remote, symlinked)
#   id_ed25519    SSH key, forced to unraid-deploy-seerr.sh in root's authorized_keys
#   known_hosts   shared, symlinked
#   host          Unraid IP as seen over WireGuard (shared, symlinked)
#   lan_endpoint  optional, e.g. 192.168.7.119:51820, used when you're home (shared)
#
# One-time setup (Ryan):
#   1. mkdir -m 700 ~/.config/unraid-deploy-seerr && cd ~/.config/unraid-deploy-seerr
#      for f in wg0.conf host known_hosts lan_endpoint; do ln -s ../unraid-deploy/$f .; done
#   2. ssh-keygen -t ed25519 -N '' -C unraid-deploy-seerr -f ~/.config/unraid-deploy-seerr/id_ed25519
#   3. Copy scripts/unraid-deploy.sh to Unraid as /boot/config/scripts/unraid-deploy-seerr.sh
#      (set CONTAINER at its top if your container isn't named Seerr).
#   4. webGUI -> Users -> root -> SSH authorized keys, add one line:
#      command="bash /boot/config/scripts/unraid-deploy-seerr.sh",restrict <contents of id_ed25519.pub>
#   5. webGUI -> Docker -> Add Container, once:
#      Name Seerr, Repository ryanbautista97/seerr-ios:v1.0.0 (a pinned tag, not latest),
#      port 5055 -> 5055, path /app/config -> /mnt/user/appdata/seerr
#      (chown -R 1000:1000 /mnt/user/appdata/seerr first; the image runs as uid 1000),
#      variables APNS_KEY (p8 body) and APNS_ENV=prod, Extra Parameters --restart unless-stopped.
set -euo pipefail

CONF="${UNRAID_DEPLOY_DIR:-$HOME/.config/unraid-deploy-seerr}"
REPO="hiryanbautista/seerr"

for f in wg0.conf id_ed25519 known_hosts host; do
  [[ -f "$CONF/$f" ]] || { echo "missing $CONF/$f (see header of $0)" >&2; exit 1; }
done

TAG="${1:-}"
if [[ -z "$TAG" ]]; then
  # A publish still running would leave us deploying the previous tag.
  status=$(gh run list --repo "$REPO" --workflow docker-image.yml -L 1 --json status -q '.[0].status')
  [[ "$status" == "completed" ]] || { echo "docker-image.yml is $status; wait for it" >&2; exit 1; }
  # The publish job pushes vMAJOR.0.MINOR, then bumps MINOR.
  major=$(gh variable get SEERR_MAJOR --repo "$REPO")
  minor=$(gh variable get SEERR_MINOR --repo "$REPO")
  TAG="v${major}.0.$((minor - 1))"
fi
[[ "$TAG" =~ ^v[0-9]+\.0\.[0-9]+$ ]] || { echo "bad tag: $TAG" >&2; exit 1; }

ENDPOINT=$(sed -n 's/^Endpoint *= *//p' "$CONF/wg0.conf")
# At home the router won't hairpin to its own public IP: use the LAN endpoint.
if [[ -f "$CONF/lan_endpoint" ]] &&
   [[ "$(curl -fsS -m 5 https://api.ipify.org || true)" == "$(dig +short "${ENDPOINT%:*}" | tail -1)" ]]; then
  ENDPOINT=$(<"$CONF/lan_endpoint")
fi

# Built once, so a deploy downloads nothing (Proxyman's system proxy breaks apk).
RUNNER="unraid-deploy:local"
docker image inspect "$RUNNER" >/dev/null 2>&1 || docker build -q -t "$RUNNER" - <<'EOF'
FROM alpine:3.22
RUN apk add --no-cache wireguard-tools openssh-client && mkdir -p /etc/wireguard
EOF

echo "Deploying $TAG via $ENDPOINT"
docker run --rm --cap-add NET_ADMIN --sysctl net.ipv4.conf.all.src_valid_mark=1 \
  -v "$CONF:/conf:ro" -e HOST="$(<"$CONF/host")" -e TAG="$TAG" -e ENDPOINT="$ENDPOINT" \
  "$RUNNER" sh -euc '
    # No resolvconf in the container, and we connect by IP. wg-quick would take
    # the container MTU (65535) minus 80, too big for the internet. Route only
    # HOST: a LAN IP in AllowedIPs would swallow handshakes to the LAN endpoint.
    sed -e "/^DNS/d" -e "s/^Endpoint *=.*/Endpoint=$ENDPOINT/" -e "s/^AllowedIPs *=.*/AllowedIPs=$HOST\/32/" \
      -e "s/^\[Interface\]/[Interface]\nMTU=1420/" /conf/wg0.conf > /etc/wireguard/wg0.conf
    wg-quick up wg0 2>/dev/null
    install -m 600 /conf/id_ed25519 /root/key
    ssh -i /root/key -o UserKnownHostsFile=/conf/known_hosts -o ConnectTimeout=15 "root@$HOST" "$TAG"
  '
