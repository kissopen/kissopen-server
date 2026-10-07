# Independent server deployment — 2026-10-06

Authorised destination: the existing `https://kissopen.com` installation.
Release identifier: `20261006T060936Z-independent-server`.

## Active services

- Relay: `/opt/kissopen/releases/20261006T060936Z-independent-server`;
  systemd `kissopen.service`, loopback port 3005.
- Accounts: `/opt/kissopen-accounts/releases/20261006T060936Z-independent-server`;
  systemd `kissopen-accounts.service`, loopback port 8081.
- Relay start **and startup migration** run the built
  `packages/kissopen-server-self-host/dist/standalone.mjs`. Neither uses `tsx`.
- Existing environment files and systemd credential loading are unchanged.
- Existing client web export and separately hosted plugin assets are preserved.

## Checks performed

1. Frozen production dependency installation and Prisma generation on Linux;
   Linux image-processing runtime smoke.
2. Real PostgreSQL schema-only compatibility and authenticated API smoke with
   synthetic identities. The disposable database was removed afterwards.
3. Consistent relay-data and account-database/file backups while both services
   were stopped; backups remain private under
   `/var/backups/kissopen/20261006T060936Z-independent-server`.
4. Candidate relay startup against a private clone of the existing data, with
   NodeLoc availability, web export and `/v1/updates/` polling handshake checked.
5. Live switch and public HTTPS checks: web/config 200, unauthenticated private
   APIs 401, removed billing/cloud-schedule APIs 404, relay polling handshake
   200 and actual TLS WebSocket upgrade/Engine.IO handshake passed.
6. Original environment/credential file hashes and account-profile snapshot
   match; user/identity/theme counts unchanged. Both services running, zero
   automatic restarts immediately after deployment; nginx configuration valid.

An initial switch hit the old `ExecStartPre` tsx migration command and rolled
back automatically. The override now updates both migrate and serve commands;
the second switch passed. An earlier probe used Socket.IO's default path and
returned 404 on both versions; verification uses the actual `/v1/updates/` path.

## Rollback

Previous releases remain intact:

- Relay: `/opt/kissopen/releases/20261005-accounts-login`.
- Accounts: `/opt/kissopen-accounts/releases/20261006-local-plugins`.

Stop both services before reverting their `current` symlinks. Remove only the
new relay override
`/etc/systemd/system/kissopen.service.d/50-independent-runtime.conf`, then
daemon-reload and start the old services. No destructive schema changes were
performed. Do not restore a database backup blindly over subsequent user writes.

No desktop/Agent restart, Git push or public-source release was performed.
An actual OAuth sign-in, native pairing and mobile library end-to-end test remain
manual acceptance checks. Dependency/public-release gates remain in
`verification.md` and `release-checklist.md`.
