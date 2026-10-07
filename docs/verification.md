# Local extraction verification

## 2026-10-07 public source snapshot

The GitHub source publication keeps `releaseReady: false`: it is not a binary
release, dependency/security certification, deployment or database migration.
The actual staged source export passed source hygiene and Gitleaks 8.30.1 scans.
A clean frozen-lockfile install, Prisma generation, Node runtime/Go builds,
wire/server typechecks, 26 wire tests, 151 server tests, Go tests and Go vet passed.
The integration fixture now copies its public-key bytes into an ArrayBuffer-backed
Uint8Array for the Prisma typed query; product authorization behavior is unchanged.

The current `pnpm audit --prod` reports 0 critical, 3 high and 5 moderate affected
dependency paths. These are outstanding advisories, not a clean security result.
The formal release checklist remains independent of source publication.

## Earlier verification

Completed on 2026-10-06, from this independent checkout, not from the product's
shared `node_modules`:

- Node wire/server typechecks and runtime bundle build; Go account binary build.
- 26 wire tests and 129 relay tests.
- Six account test groups (including subcases): removed commercial APIs,
  capability flags, anonymous access, origin checks, config validation and upload/catalog limits.
- Go vet.
- Fresh and repeated relay migrations, additive account/theme/admin SQL checks,
  standalone startup, anonymous account endpoint rejection and empty provider list.
- Real relay database encryption-key sign-in, machine creation and isolation between two fresh test accounts.
- Source hygiene scan: no detected private environment files, private keys,
  commercial deployment hosts or operator home paths in the exported source.

This is not a completed production or OAuth acceptance test. Google/GitHub/
NodeLoc sign-in, authenticated account CRUD on a real PostgreSQL server, native
device pairing, library access and restoration remain manual integration gates.
No production database or running desktop/Agent was used or restarted.

## Known inherited dependency risks

`pnpm audit` reported 18 advisories (2 critical, 6 high, 10 moderate) during
extraction. These include the test runner's Tinypool and other transitive packages.
They are not hidden by the passing build or source scan. Resolve and re-test
affected dependency chains before declaring a public release ready; consult the
current audit output rather than assuming today's counts remain fixed.

The inherited PGlite Prisma adapter declares a Prisma 7 peer requirement while
this baseline uses Prisma 6.19.2. Typechecks and local smoke checks pass, but the
peer warning is retained as a compatibility risk, not silently overridden.

Run `pnpm audit:source` for source hygiene and `pnpm audit` for npm advisory
checks; these are different checks. Package publication remains disabled.

## Authorised deployment verification (2026-10-06)

The separate deployment is recorded in `deployment-2026-10-06.md`; the preceding
extraction-only results remain historical. `@fastify/static` was upgraded to
10.1.2 and `sharp` to 0.35.4, then build, typechecks, all 155 TypeScript tests,
Go tests/vet, isolated relay/database smoke and source hygiene were rerun.

The opt-in `TestDeploymentPostgres` additionally passed on real PostgreSQL with
a schema-only copy of the existing deployment: profile persistence, stable
identity mapping, two-account isolation, theme selection, sign-out revocation,
non-admin rejection, 51 catalog entries and a downloaded package checksum.
It rejects database names outside `kissopen_deploy_test_*` and does not use live
account credentials or customer rows.

After those upgrades, `pnpm audit --prod` reports 7 advisories (0 critical,
2 high, 5 moderate): Effect/deepmerge-ts are Prisma CLI/config dependencies;
decode-uri-component/stream-json enter through optional MinIO, which is not
configured on this deployment; uuid's reported buffer API is not used by relay
source. This is exposure triage, not a claim that these advisories are fixed.
Dev/test-runner advisories and the Prisma adapter peer warning also remain
public-release review gates. No audit suppressions were added, and production
installation excludes dev dependencies. Re-evaluate before enabling S3 or
changing the deployment profile.

## Account security local verification (2026-10-06)

At the time of this local verification, the change had **not** been deployed. No desktop/Agent was restarted,
and no production users, passwords, OAuth credentials or database rows were used.

- Wire/server typechecks and both runtime builds pass; 26 wire and 144 server
  tests pass, including 15 new cryptography/security integration tests.
- Security integration tests use a disposable migrated PGlite database and a
  fake OAuth identity exchange. They cover legacy identity/workspace preservation,
  password hashing, session-bound single-use proofs, password and OAuth MFA,
  TOTP/recovery replay, concurrent recovery consumption, expiry, throttling,
  last-method unlink protection, conflicting account links and binding ownership
  changes between lookup and identity lock. Real provider acceptance remains a
  deployment integration gate.
- Go account tests/vet and binary build pass. Fresh/repeated relay migration,
  startup and two-account encryption-key isolation smoke checks pass.
- Desktop UI/App/Electron and mobile typechecks pass; Electron renderer, main
  and preload production builds pass using the workspace's `tsx` loader.
- Security/login Blueprint fixtures render without browser errors; changed
  desktop UI files pass targeted ESLint. Existing FormRow tests pass across
  Chromium, Firefox and WebKit.
- Existing Electron tests: 150 pass, one skipped. Existing App tests: 44 pass,
  three workspace-fixture failures remain (`projectAdd.pending` and missing
  jsdom `IntersectionObserver`). Existing TextField focus-color parity tests
  fail in three browsers: they expect the old blue focus ring instead of the
  existing KissOpen purple. Those components/fixtures were not changed here.
- The full sync SDK typecheck still has its inherited duplicate `getDisplayName`
  re-export in `sources/index.ts`; consuming clients typecheck and build. The
  repository-wide React boundary check also still reports 50 inherited violations
  in the legacy Electron relay views; none are in the new security implementation.

Before rollout, back up the databases and persistent relay master secret, apply
the additive migration, then run the offline legacy-username reservation tool.
Never regenerate the master secret: existing TOTP secrets depend on it. Verify
real OAuth sign-in, 2FA and workspace restoration on staging before production.

## Account security deployment verification (2026-10-06)

The subsequent user-authorised deployment and desktop restart are recorded in
`deployment-account-security-2026-10-06.md`. Linux production installation,
Prisma generation, static Go build and production web export passed. Candidate
services were exercised against a consistent private relay clone and a
disposable, schema-only PostgreSQL account database with synthetic credentials.
Password login, MFA gating, TOTP enablement, one-time recovery consumption and
replay rejection passed through the account proxy. Legacy identity/workspace
keys and account-profile snapshots remained unchanged after migration.

Both live services are running; public web and relay polling checks passed,
unauthenticated security APIs return 401, and the removed billing API remains
404. The rebuilt desktop was restarted using its existing development profile;
its authenticated local Agent health reports ready, without drain or shutdown.
No live user password/2FA setting was changed. Real OAuth and native/mobile
security interaction remain manual acceptance checks; earlier inherited test
and dependency risks are not superseded by this deployment.
