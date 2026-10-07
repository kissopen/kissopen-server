# Account security contract

The relay is the authentication authority; the account service retains profile,
avatar and theme data. All sign-in methods resolve to the same immutable
CommunityIdentity ID. Email is never an account linking key. Existing workspace
public keys and encrypted data are not changed by password or MFA operations.

## Public sign-in

- `POST /v1/community/auth/password {username,password}` returns a short-lived
  `{id,pollToken,expiresAt}` authorization, not an authenticated session.
- OAuth `/auth/start` remains compatible. `/auth/:id/status` additionally returns
  `second_factor` when an authenticator or recovery code is required.
- `POST /auth/:id/factor {code}` authenticates that authorization using its poll
  token. Both password and OAuth require MFA when enabled.
- Existing `/auth/:id/complete` is available only after all factors succeed.
  Workspace key proof and account-key conflict protection are unchanged.

## Authenticated security API

`GET /v1/community/security` returns username, password/MFA availability and
configured/linked OAuth providers. No hashes, secrets or provider credentials.
The accounts service proxies the explicitly listed paths under `/api/security`.

Usernames are edited in the existing personal-profile editor, not Security.
The personal-profile header also owns password editing: it displays "Set password"
until password sign-in is enabled, then "Change password". A single modal accepts
the new password twice and, for changes, the current password. It also requests
MFA when enabled. Existing-password changes verify the supplied current password
before mutation; first-password setup authorizes the linked OAuth provider.
There is no second password editor in Security and no extra verification modal
for password changes. Passwords remain transient form/auth-boundary data.
`POST /api/profile {display_name?,username?}` forwards changed usernames to
`POST /v1/community/profile/username {username:string|null}` using the current
authenticated session, with no standalone security proof. The relay reserves the
unique lowercase login name; the accounts service mirrors it for display.
Clearing a username is rejected while password sign-in is enabled. Unchanged
profile usernames do not issue an unnecessary relay mutation. A failed username
reservation does not save the submitted display name. Account reads reconcile
the authoritative relay username (including null), so later reads repair a
mirror after an interrupted response or database write.

`POST /security/verify {password?,code?}` issues a five-minute, single-use proof
bound to the current session after current-password and (if enabled) MFA
verification. An account without a password must have a fresh OAuth session.
Older sessions may start OAuth with `intent: reauthenticate`; completing it via
`/security/oauth/complete {id,pollToken}` issues the proof without changing account.

Proof-protected mutations:

The desktop no longer exposes a standalone "Verify identity" area or a
globally verified state. Selecting a sensitive operation obtains and immediately
consumes a single-use proof for that operation: password accounts confirm with
their current password (and MFA when enabled); provider-only accounts complete
their linked provider authorization. Cancelling or leaving Security discards the
pending operation. This removes the separate preparatory step, not the backend
protection for passwords, MFA and account links.

- `/security/username {proof,username}` reserves a unique, case-insensitive
  username (3–20 letters, digits or underscores).
- `/security/password {proof,password}` sets/replaces a password of 12–128
  characters. Other login sessions and outstanding authorizations are revoked;
  existing paired workspace encryption keys remain intact.
- `/security/totp/begin {proof}` returns a ten-minute setup token, Base32 secret
  and otpauth URI. `/security/totp/confirm {setupToken,code}` enables MFA only
  after a correct code and returns recovery codes once.
- `/security/totp/disable {proof}` disables MFA.
- `/security/recovery {proof}` replaces recovery codes, displayed once.
- `/security/oauth/start {proof,provider,intent:link|reauthenticate}` starts
  browser authorization bound to the current session and identity.
- `/security/oauth/unlink {proof,provider}` cannot remove the last usable login
  method. Linking to a provider already owned by another identity is refused.

Passwords use salted scrypt (N=131072,r=8,p=1) with bounded concurrency. TOTP
secrets are authenticated-encrypted with a domain-separated key derived from
the persistent relay master secret. Recovery codes are hashed and atomically
consumed. Authenticator timesteps cannot be replayed. Failed password/factor
attempts are throttled durably by hashed identity/IP keys. Authentication route
logging and caching are disabled. Secrets are never persisted in client stores.

## Migration and rollout

### Account-scoped server-encrypted workspace escrow

The relay is the single workspace identity authority. Normal account login
(password or OAuth, with MFA where enabled) can restore the same workspace on
desktop/mobile without a QR code, recovery-key prompt or an online old device.
This does not provision a cloud Agent or move local files into a cloud drive.

- `POST /v1/community/workspace/session {recipientKey}` authenticates the current
  account session and locks its identity. A new identity gets one random 32-byte
  seed, a relay account and encrypted escrow in the same transaction. Concurrent
  logins cannot create different keys. The `ready` response includes identityId,
  publicKey, workspaceToken and a seed envelope encrypted to that request's
  ephemeral recipient key. Clients verify identity and the decrypted seed's
  public key before saving it or activating sync.
- If an existing workspace has no escrow, the response is `restore_required`
  with identityId and publicKey, never a replacement workspace. The client can
  migrate its matching local/recovery/peer seed with
  `POST /v1/community/workspace/escrow {secret}` over HTTPS. Seed ownership must
  match the existing relay binding. Cross-account keys and replacements fail.
- Escrow is AES-256-GCM with a versioned, domain-separated key from persistent
  `HANDY_MASTER_SECRET`; associated data binds identity, relay account and public
  key. Neither seeds nor relay tokens are stored in plaintext. Request logging
  is disabled, responses are `no-store`, and these operations are throttled.
  Unreadable escrow fails closed; it never triggers regeneration.
- `/api/workspace/session` and `/api/workspace/authorize` return authenticated
  upgrade errors, rather than creating a second workspace in the Go service.
  Its old database table remains intact for separately authorised migration.

Privacy boundary: the server can recover these seeds and therefore can decrypt
workspace ciphertext. This is not server-blind end-to-end encryption. Operator
master-secret backups must be separate from database backups. The client model
API keys remain local to the Agent; account login does not upload them.

### Migration of existing device-owned keys

Desktop and mobile sign in with the same CommunityIdentity rather than requiring
QR authorization. These account-bearer routes expose explicit wire schemas:

- `POST /v1/community/workspace/open {recipientKey}` creates a two-minute
  ticket bound to the requesting identity and session. It returns the existing
  workspace public key, or null before the first binding, plus a nonce challenge.
- `GET /workspace/requests` lists at most 16 pending requests from other login
  sessions of that identity; `GET /workspace/:id` reads only the caller's ticket.
- `POST /workspace/:id/deliver {envelope,signature}` accepts only a matching
  workspace owner's signature over the ticket and encrypted envelope. Both
  sender and recipient account sessions must remain live.
- `POST /workspace/:id/complete {publicKey,signature}` proves possession of the
  workspace seed and returns its relay token, consuming the challenge once.
  Existing workspace bindings cannot be replaced or merged into another identity.
- `POST /workspace/pair {authorization,envelope?}` validates an existing fresh
  V2 Agent authorization and submits its encrypted content-key response. The
  server owns decoding the opaque Agent data; desktop does not reconstruct it.

These transfer routes remain available only for migrating a pre-escrow binding.
An old device may transfer its matching seed, after which an authenticated client
imports it into server-encrypted escrow. Logout deletes the current session's
pending transfers. If no existing key is available, the workspace remains intact
and inaccessible; it is not silently reset. Previous QR credentials may be reused
only after their public key matches the authenticated account. Normal escrowed
accounts do not depend on peers or these transfer routes.

Mobile treats account sign-in and workspace readiness as separate states.
Successful password/OAuth sign-in persists its valid account session and opens
the dedicated `/devices/connect` screen immediately; it does not wait for a
peer seed on the sign-in form. A transfer timeout/expired ticket is recoverable
and must not revoke that account session. The connection screen retries bounded
transfers while foregrounded and displays account, encryption and desktop
presence separately. An offline desktop is not a failed account login.
Recovery-key entry is a legacy migration only: it must match the existing binding
before being uploaded over HTTPS into escrow; incomplete or mismatched keys are
rejected without replacing history. Normal account login restores escrow directly.
Saved relay credentials and their decrypted caches are restored only after
the current account identity matches their owner. Protected deep links remain
behind that check; sign-out closes them and cancels pending delivery/bootstrap
before waiting for network acknowledgement.

Schema migration adds security fields and authoritative OAuth bindings,
backfilling bindings from existing identities. Canonical identity IDs do not
change. Before rollout, run `scripts/migrate-account-usernames.mjs` with the
accounts database URL and relay database URL to reserve existing profile
usernames; it fails closed on conflicts. The profile username editor remains
editable and uses the relay's authoritative reservation route. Build both
wire packages/SDKs before clients. The initial implementation was local-only;
the subsequently authorised deployment is recorded in
`deployment-account-security-2026-10-06.md`.

There is deliberately no anonymous password registration, email auto-merging,
SMS recovery or admin MFA bypass. Losing all linked OAuth access, the password
and all MFA recovery codes requires an independently designed recovery process.
