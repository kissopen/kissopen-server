# Same-account device login deployment — 2026-10-06

User-authorized relay release: `20261006T173300Z-device-login` on the existing
KissOpen server. `kissopen.service` runs the new standalone bundle at loopback
3005; accounts remains on `20261006T071832Z-account-security` at loopback 8081.
HTTPS at `kissopen.com` routes authentication and relay traffic unchanged;
`app.kissopen.com` serves the rebuilt account-login web client. Other sites and
the independent plugin assets remain untouched.

Before activation, a private consistent backup and a separate PGlite clone
were made. Linux production dependencies and Prisma generation succeeded.
The candidate clone preserved existing identity/public-key bindings and passed
first binding, one-time proof/replay rejection, cross-account isolation,
recipient-encrypted seed recovery and actual relay-token acceptance. Synthetic
test identities were confined to the clone, never inserted into the live database.

The additive workspace-transfer migration was applied with the live relay
stopped, followed by an atomic `current` symlink switch and readiness checks.
Identity, workspace-key and private-configuration snapshots matched before and
after deployment. Public provider availability and anonymous workspace API 401
checks passed; relay/accounts were active and relay automatic restart count was
zero. Backups and the previous release pointer are retained privately at
`/var/backups/kissopen/20261006T173300Z-device-login`.

Local validation: 148 server tests, 4 shared encrypted-bootstrap/migration tests,
15 existing desktop transport tests, 11 existing Agent pairing tests and 8 mobile
onboarding tests passed. Mobile
and Electron typechecks, full desktop build, web export and iOS archive/export
passed. Existing shared-package duplicate-export typecheck failures and 50
inherited desktop React-boundary violations were not introduced or fixed here.
Native installation is not proof of real-user OAuth/password login or encrypted
history acceptance; those require the user's account/device interaction.

Final iOS test package 0.2.29 (13) was installed and launched on Jennr's iPhone;
CoreDevice confirmed its version and running process. The development desktop
was rebuilt and restarted with the final implementation. Its local Agent is
ready, but the current account's encrypted workspace association still requires
an existing device holding the matching seed; no success is claimed for that
real-account end-to-end recovery yet. The web client was also refreshed with
the final legacy-key migration implementation.

No commercial database, account credentials, cloud Agent or scheduler was copied
or enabled. No Git push, App Store or public native release was made.

Rollback retains the previous relay release `20261006T071832Z-account-security`.
Stop the relay before changing its symlink. Keep the additive table and account
bindings; do not overwrite subsequent user writes or regenerate the master
secret from the backup merely to revert the executable.
