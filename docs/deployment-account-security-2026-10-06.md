# Account security deployment — 2026-10-06

Authorised destination: the existing KissOpen installation.
Release identifier: `20261006T071832Z-account-security`.

## Active services and preserved state

- Relay: `/opt/kissopen/releases/20261006T071832Z-account-security`;
  `kissopen.service`, loopback port 3005.
- Accounts: `/opt/kissopen-accounts/releases/20261006T071832Z-account-security`;
  `kissopen-accounts.service`, loopback port 8081.
- Both `current` symlinks point to the new release. Relay migration and serving
  use the built standalone runtime, retaining the existing systemd override.
- Existing environment files, systemd credentials, persistent master secret,
  account identities and workspace encryption keys were preserved.
- Production web export was rebuilt with the existing HTTPS relay/account
  origin. Existing `.well-known` and separately hosted plugin assets remain.
- Activation was limited to the account API and relay services.

## Backup, staging and activation

Consistent database/file backups and private configuration snapshots remain in
`/var/backups/kissopen/20261006T071832Z-account-security`. A fresh pre-activation
backup was taken after staging, before the live migration. Backups are private
and are not exported into the repository or served publicly.

Linux frozen production dependency installation, Prisma generation and image
processing smoke passed. The account binary was cross-built for Linux amd64.
Candidate services ran against a private relay clone and a disposable
PostgreSQL schema-only copy, using synthetic identities and in-memory test
credentials. Checks included authenticated security reads, password verification
and login, MFA gating, TOTP setup/enablement, recovery code consumption and replay
rejection, and canonical username profile mirroring. Temporary services stopped
and the disposable PostgreSQL database was removed afterwards.

The offline username migration initially failed before the live migration:
libpq does not interpret a connection URI placed in `PGDATABASE`. The tool now
parses the URI and passes database, Unix socket host, user, port, password and
SSL mode through the corresponding libpq environment variables. Credentials
are not placed in process arguments or logs. The corrected tool passed staging
and live legacy-username reservation. Original services were restored during
the failed preparation; no live schema rollback was needed.

Activation applied the additive relay migration and username reservation before
switching both releases. Identity/workspace-key snapshots, account-profile
hashes and configuration-file hashes matched their pre-migration values.
Both services reported active with zero automatic restarts immediately after
activation; nginx configuration validation passed.

## Post-deployment checks

- Public web and Security SPA route return 200 with the new web bundle.
- Existing configured OAuth provider remains available.
- Unauthenticated relay and account security APIs return 401.
- Relay Engine.IO polling handshake succeeds on `/v1/updates/`.
- Removed billing history API remains 404.
- Desktop renderer/main/preload were rebuilt and the development app gracefully
  restarted using its existing data profile. Authenticated local Agent health
  returns ready, not draining or shutting down.

No live user's password, 2FA or OAuth bindings were changed. Real provider
sign-in, security form interaction and native/mobile restoration remain manual
acceptance checks. Existing dependency and inherited test risks remain in
`verification.md`. No Git commit/push or native installer publication was made.

## Rollback cautions

Previous relay and account releases remain available as
`20261006T060936Z-independent-server`. Stop both services before changing their
`current` symlinks; retain the existing standalone migration/serve override.
The migration is additive, but the old runtime's username-index expectations
must be reviewed and restored by a controlled migration if reverting. Do not
blindly restore a database backup over subsequent user writes or regenerate
the master secret. Once users enable MFA, reverting to a runtime without MFA
enforcement could bypass their security settings; assess that before rollback.
