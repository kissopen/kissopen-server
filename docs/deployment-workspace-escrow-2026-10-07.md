# Workspace escrow / iPhone reset deployment — 2026-10-07

Release `20261007T034000Z-workspace-escrow` supports the user-requested new
iPhone installation and explicit history/workspace reset.

Relay and independent accounts current pointers now reference this release.
An additive encrypted-seed column was migrated. Linux fresh-database smoke and
a private clone migration passed before activation, including two-device
same-account seed restoration, relay token acceptance and device isolation.
The real account's old empty workspace binding was reset only after verifying
the canonical identity through the desktop's existing login and account DB.
The maintenance transaction aborts if the binding, owner or empty dependent
tables change. Account login/profile/security/OAuth data was not deleted.
Old account sessions were revoked to prevent stale clients reusing old keys.

Private consistent pre-reset relay/file and account database backups remain
under `/var/backups/kissopen/20261007-workspace15`. Final PGlite and PostgreSQL
snapshots were taken with services stopped. Secrets and configuration hashes
were preserved. Backups are protected by a mode-0700 parent, with dumps mode
0600. Keep the master secrets when restoring; do not overwrite subsequent writes.

Both services are active, with zero automatic restarts. Loopback account health,
public configured OAuth availability, unauthenticated workspace rejection,
actual relay polling path and nginx config validation passed. The public root
`/healthz` is not exposed by nginx (404); it is not claimed as a passing check.

Previous runtime releases remain for rollback. Stop services before reverting
current symlinks; the additive migration can remain, but reverting does not undo
the explicitly requested account reset. Backup restoration is a separate,
scoped operation requiring care with any newer user data. Activation was limited
to workspace recovery. No Git push or desktop restart was performed.

## Follow-up: matching key migration and device connection

The user subsequently approved preserving the current workspace, migrating its
matching desktop-held seed and restarting the already-built desktop. The old
desktop process had created another device-only binding after the reset. Its
saved seed matched the canonical identity and workspace public key. Import into
escrow and encrypted recovery verification succeeded without replacing the seed
or clearing any additional data. The desktop was restarted from the built OSS
package, retaining its existing profile, Agent history and model settings.

Real device verification exposed two additional server boundary defects:

- Terminal authorization uses `privacy-kit.encodeHex` (uppercase), whereas the
  account pairing route searched lowercase. The route now uses the same encoder
  as the real Agent registration endpoint. A regression test registers through
  `/v1/auth/request`, authorizes through account pairing, and polls authorization.
  Expired/non-V2 requests and another account still fail closed.
- PGlite's driver returned typed arrays for Bytes columns; Prisma 6's result
  transport serialized these as numeric-key objects and rejected device reads
  with P2023. A PGlite-only compatibility wrapper normalizes binary result values
  to plain arrays, including interactive transactions and shadow connections.
  Database bytes, bound parameters and the PostgreSQL path are unchanged.

All 151 server tests and production typechecking pass. A disposable Linux
candidate verified actual authorization registration/polling, encrypted binary
device-key creation, repeated registration, device listing and account isolation.
No production database was opened concurrently for diagnostics.

Relay release `20261007T040700Z-device-bytes` is active. The accounts binary
remains on `20261007T034000Z-workspace-escrow`. Consistent private relay snapshots
precede both follow-up activations under `/var/backups/kissopen/` with their exact
release names; original releases remain available for rollback. Configuration
hashes and master secrets were preserved, and no schema/data reset was performed.
Both services are active with zero automatic restarts. The current local desktop
Agent reports `connected`, `configured: true`, with no pending authorization.
Public OAuth availability and the actual Engine.IO endpoint also pass checks.
Phone foreground application verification is separate from those checks; do not
claim user sign-in merely from installation or a running process.

After resuming/foregrounding the installed phone app, its newly written relay
cache contained one active machine with an encrypted device key. Only counts
and status were inspected, not credentials or conversation contents. This
confirms workspace recovery/device discovery reached the real phone. The mobile
connection screen also incorrectly used voice-session `realtimeStatus`; it was
changed to the account sync socket status, so an inactive voice call no longer
prevents the connected state. Mobile typechecking passes; the updated native
build/install is tracked separately in the iPhone installation report.

Mobile build 0.2.29 (16) was subsequently archived, exported, signature/profile
verified and installed over build 15 on Jennr’s iPhone without uninstalling or
clearing data. Installed app inventory confirms build 16 and launch succeeded.
The post-install relay cache's latest three machine snapshots each contain one
active desktop with an encrypted device key; only counts/booleans were inspected.
The native build and checks are recorded in the app's
`build/ios-test/WORKSPACE16-REPORT.md`. No visual UI success is inferred solely
from these cache checks.
