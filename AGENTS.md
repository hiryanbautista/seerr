# AGENTS.md: Seerr server (Ryan's fork)

Fork of `seerr-team/seerr` (`origin` = hiryanbautista/seerr, `upstream` = seerr-team/seerr). Working branch: `develop`.
It replaces the old Overseerr fork at `../overseerr` and backs the iOS app at `../../../App/Overseerr` (bundle `io.ryanbautista.Overseerr`).

## Hard rules
- **Never merge or rebase `upstream` unless Ryan explicitly asks.** `git fetch upstream` is fine.
- **Don't commit or push unless asked. PR-only into `develop`.** A push to `origin/develop` runs `.github/workflows/docker-image.yml`, which builds and pushes `ryanbautista97/seerr-ios:latest` to Docker Hub. Ryan merges.
- **Never open PRs, issues or comments on `seerr-team/seerr`.** Its CONTRIBUTING.md bans AI-driven contributions. `gh` defaults to the upstream repo on forks, so always pass `-R hiryanbautista/seerr`.
- Never edit a shipped migration. Add a new one.
- Don't touch `config/` (gitignored local settings and DB).

## Fork-only code (keep the diff small; mark new files with a `Fork-only` comment)
- iOS push over APNs: `server/lib/notifications/agents/ios.ts`, registered in `server/index.ts`.
- Token table: `server/entity/UserIOSDevice.ts` (added to the entity list in `server/datasource.ts`), plus migration `server/migration/sqlite/1793329975544-AddUserIOSDevice.ts`. Tokens live in their own table on purpose: SQLite migrations rebuild `user_settings` and would drop any column we add there.
- `ios` notification key in `server/lib/settings/index.ts` and `server/entity/UserSettings.ts`.
- Routes: `/settings/notifications/ios[/test]` in `server/routes/settings/notifications.ts`. `iOSDeviceToken` is accepted and returned by `/user/{id}/settings/notifications` (`server/routes/user/usersettings.ts`).
- Spec: `seerr-api.yml` (`iOSSettings`, the paths above, `iOSDeviceToken`, `NotificationAgentTypes.ios`). The OpenAPI validator rejects anything that isn't in the spec.
- `.github/workflows/docker-image.yml`.

## Commands
Node `^22.19` (engine-strict). nvm has 22.23.4; run `nvm use 22.23.4` first. pnpm 10 is installed through Homebrew.

| Task | Command |
|---|---|
| Install | `CYPRESS_INSTALL_BINARY=0 pnpm install --frozen-lockfile` |
| Dev server (:5055) | `pnpm dev` |
| Typecheck | `pnpm typecheck` (server + client; both pass) |
| Lint / format | `pnpm lint`, `pnpm format:check` |
| Tests | `pnpm test` |
| Build | `pnpm build`. **Local caveat:** tsc-alias silently rewrites 0 files when the path contains `(v3)`, so `dist/` keeps `@server/...` imports and won't start. Docker builds (in `/app`) are fine. For a local prod run, build in a copy at a path without parentheses. |
| Docker | `docker build --build-arg COMMIT_TAG=local -t seerr-ios:local .` |

## Migrations (TypeORM 0.3, SQLite and Postgres)
- `server/datasource.ts`. Entities are listed by hand, so add new ones there. Dev uses `synchronize: true`. Prod runs `dist/migration/sqlite` (or `postgres` when `DB_TYPE=postgres`).
- To generate: point `CONFIG_DIRECTORY` at a scratch dir, run `pnpm migration:run`, then `pnpm migration:generate server/migration/sqlite/<Name>`. Tidy the output and re-run generate to confirm "No changes". The fork only ships SQLite migrations; Ryan doesn't use Postgres.
- Overseerr import: on first start, a config with no `main.mediaServerType` is treated as Overseerr and migrated by `server/lib/overseerrMerge.ts`. Back up `config/` first; there's no going back without the backup.

## Running and deploying
- Image `ryanbautista97/seerr-ios`, port 5055, config in `/app/config` (`settings.json`, `db/db.sqlite3`).
- **The container runs as `node` (uid 1000), not root.** The host config dir must be writable by uid 1000.
- Env: `APNS_KEY` (p8 body, `\n` escaped) and `APNS_ENV=prod` for production APNs (any other value means sandbox). Key ID, Team ID and topic are constants in `ios.ts`.
- Repo variables `SEERR_MAJOR`/`SEERR_MINOR` and secrets `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`, `REPO_ACCESS_TOKEN` need to be set on hiryanbautista/seerr. Once Actions is enabled, disable every upstream workflow except Docker Image CI (`gh workflow disable -R hiryanbautista/seerr <name>`).

## Orchestrator context sync
- After a direct task that changes API endpoints, entities/migrations, auth, conventions, or deployment, `t3_thread_send` the orchestrator (thread 22b9b0da-e70b-4886-8441-ab5aa773f00e) a replacement for the affected sections of `context/server-context.md`.
- When the orchestrator asks for changes since your last context update, reply with them or "none".
