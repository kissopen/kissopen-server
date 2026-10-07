# Public release gate

- [ ] Publish source only after explicit owner approval and source/secret review.
- [ ] Review MIT notices, all dependency licenses and each separately distributed plugin license.
- [ ] Run `pnpm audit:source` hygiene checks and `pnpm audit` dependency checks; independently review secrets and security.
- [ ] Run a clean frozen-lockfile install, build, typecheck, server tests and Go vet.
- [ ] Exercise OAuth for all configured providers using dedicated test identities.
- [ ] Verify first login, returning login, logout/revocation and account isolation end to end.
- [ ] Validate profile/avatar, theme upload/save/gallery and catalog install on real clients.
- [ ] Verify mobile device pairing, encrypted attachments and local-Agent RPC across two devices.
- [ ] Verify offline behavior; no claims of offline remote file access without cached content.
- [ ] Check external PostgreSQL and fresh/restored PGlite migrations and backup recovery.
- [ ] Confirm exposed API routes match the documented account and relay capabilities.
- [ ] Deploy only on separate explicit instruction, after backup and migration review.

`EXTRACTION.json.releaseReady` stays false until the public release gate has
been completed. Local compilation and unit tests alone do not mark it ready.
