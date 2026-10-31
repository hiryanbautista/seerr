#!/bin/bash
# Fork-only, copied from prefect-remote. Runs on Unraid as the forced command of
# the deploy key used by scripts/deploy-unraid.sh, so that key can only do this.
# Copy to /boot/config/scripts/unraid-deploy-seerr.sh and add to root's
# authorized_keys (webGUI: Users -> root -> SSH authorized keys):
#   command="bash /boot/config/scripts/unraid-deploy-seerr.sh",restrict ssh-ed25519 AAAA... unraid-deploy-seerr
#
# Same as editing the container's Repository tag in the webGUI and pressing Apply.
set -euo pipefail

# >>> Unraid container name (template my-<name>.xml). Change if you renamed it.
CONTAINER="${CONTAINER:-Seerr}"
IMAGE="ryanbautista97/seerr-ios"
TEMPLATE="/boot/config/plugins/dockerMan/templates-user/my-${CONTAINER}.xml"

TAG="${SSH_ORIGINAL_COMMAND:-}"
[[ "$TAG" =~ ^v[0-9]+\.0\.[0-9]+$ ]] || { echo "bad tag: '$TAG'" >&2; exit 1; }
[[ -f "$TEMPLATE" ]] || { echo "no template: $TEMPLATE" >&2; exit 1; }

sed -i -E "s#<Repository>${IMAGE}(:[^<]*)?</Repository>#<Repository>${IMAGE}:${TAG}</Repository>#" "$TEMPLATE"
grep -q "<Repository>${IMAGE}:${TAG}</Repository>" "$TEMPLATE" || { echo "tag not written" >&2; exit 1; }

docker pull "${IMAGE}:${TAG}"
# Unraid's own Apply: recreates the container from the template.
/usr/local/emhttp/plugins/dynamix.docker.manager/scripts/update_container "$CONTAINER"

docker inspect -f '{{.Config.Image}} {{.State.Status}}' "$CONTAINER"
