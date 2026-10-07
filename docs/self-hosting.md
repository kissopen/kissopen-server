# Self-hosting

KissOpen Server runs as two services: the account API and the encrypted relay.

## Public proxy

Keep Node (3005), accounts (8081) and PostgreSQL private. Expose one HTTPS origin.
Route `/api/` to accounts; `/v1/`, `/v2/`, `/v3/`, `/files/` and
the optional built web client to the relay. `/healthz` checks the account database.
WebSocket upgrades are required for `/v1/updates/` (the relay's Socket.IO path,
not the library default `/socket.io/`). Do not proxy an arbitrary
user-supplied URL or expose an Agent debug/Docker socket.

The templates in `deploy/` are examples, not an automated deployment. Replace
the example host and install TLS using your own certificate process. Never
commit TLS files. The relay's optional object-storage/GitHub/voice integrations
are inherited and require operator-owned configuration; none is required for
standalone OAuth and encrypted device sync.

## Data and credentials

Generate two separate random secrets with at least 32 bytes of entropy:
`HANDY_MASTER_SECRET` and `CN_SECRET`. Keep them in a secrets manager or private
0600 files outside the repository. Do not reuse production credentials from
another product. Preserve the same secrets during upgrades; replacing them
can invalidate authentication or make existing encrypted records unreadable.

The relay now escrows workspace seeds using AES-256-GCM under a domain-separated
key from `HANDY_MASTER_SECRET`, with identity, account and public key as associated
data. A normal authenticated account login can recover its existing seed without
an old device. This is server-recoverable encryption, not server-blind end-to-end
encryption. Losing/changing the master secret cannot be repaired by generating a
new workspace key. Keep its backup separate from the encrypted database backup.
Existing device-only workspaces migrate only when a client presents the matching
seed; unavailable keys never trigger automatic replacement or deletion.

Create an independent PostgreSQL database for accounts and grant its role only
that database's privileges. Point `CN_DATABASE` to it. Relay PGlite and encrypted
attachments live below `DATA_DIR`; account avatars/theme images live below
`CN_IMAGE_DIR`. Stop the relay before copying its PGlite directory for a backup;
use PostgreSQL's supported backup tooling for accounts. Retain the secrets needed
to restore a backup separately from source exports. Never commit databases or
runtime data to a public repository.

Environment files are not implicitly sourced by `pnpm`. Inject settings with
your service manager. For local development only, change modes to development,
use loopback origins and a disposable database. Do not load env files with
shell tracing enabled and do not put secrets into shell command arguments.

## OAuth

Each enabled provider needs both its client ID and secret. Register the exact
callback on your public origin:

```text
https://your-kissopen.example/v1/community/auth/github/callback
https://your-kissopen.example/v1/community/auth/google/callback
https://your-kissopen.example/v1/community/auth/nodeloc/callback
```

`COMMUNITY_AUTH_PUBLIC_URL` must match that public origin. Accounts validates the
stable authenticated identity at `KISSOPEN_COMMUNITY_AUTH_URL`; it does not link
users by names or emails and does not persist raw bearer tokens. Keep that URL
operator-controlled, preferably loopback on a same-host deployment.

## Plugins and clients

Set `KISSOPEN_PLUGIN_CATALOG` to a separately prepared catalog containing
`index.json`, `details/`, `icons/` and the archives named by the index. Serve
its public icons at `/downloads/plugins/icons/` without exposing private env
files. Authenticated archive downloads verify SHA-256 before returning bytes.
Clients install and execute plugins on their local Agent.

To serve the mobile/web client, build it in the client repository against your
origin, then provide only the export directory using `KISSOPEN_STATIC_DIR`.
The server repository does not need a sibling checkout to build or run.

## Upgrade

First verify both services against a disposable database and perform a backup.
Apply relay migrations with `pnpm relay:migrate` while the relay is stopped.
The account service applies additive account/theme schema statements at startup
under a database advisory lock. Run only workers supported by this deployment
alongside the account binary. Compare old/new API payloads and authenticate
with a test account before switching the proxy. Keep the previous build/data backup for
rollback; do not delete existing tables during an upgrade.
