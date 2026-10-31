---
name: deploy-unraid
description: Deploy the published Seerr image (ryanbautista97/seerr-ios) to Unraid (switch the container's tag and apply). Use when the user says deploy, ship to Unraid, update the Unraid container, or roll back to a version.
---

<!-- Fork-only, copied from prefect-remote. -->

Run `scripts/deploy-unraid.sh` from the repo root (Bash, timeout 300000).

- No argument deploys the newest published tag. Pass `vX.0.Y` to deploy or roll back to a specific one.
- If it says `docker-image.yml is in_progress`, the publish from the merge is still running: wait with `gh run watch --repo hiryanbautista/seerr $(gh run list --repo hiryanbautista/seerr --workflow docker-image.yml -L 1 --json databaseId -q '.[0].databaseId')`, then run the script again. If that run failed, report it instead of deploying.
- Success ends with a line like `ryanbautista97/seerr-ios:v1.0.1 running`. Report the tag and that line.
- On `missing ~/.config/unraid-deploy-seerr/...`, the one-time setup isn't done: point the user to the header of `scripts/deploy-unraid.sh`. Don't create keys or VPN configs yourself.
- On an SSH or WireGuard failure, report the error. Don't retry with different flags or route around the forced-command key.
