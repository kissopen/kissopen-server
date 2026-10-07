// Offline migration: stop the relay first when using PGlite. No identity,
// password, username or database connection string is printed.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../packages/kissopen-server/package.json', import.meta.url));
if (!process.env.ACCOUNTS_DATABASE_URL) throw new Error('Set ACCOUNTS_DATABASE_URL privately.');
let database;
try {
 database = new URL(process.env.ACCOUNTS_DATABASE_URL.replace('@/', '@localhost/'));
 if (!['postgres:', 'postgresql:'].includes(database.protocol)) throw new Error();
} catch { throw new Error('Configure a valid private PostgreSQL connection URL.'); }
// libpq treats PGDATABASE literally, not as a URI. Pass connection fields via
// environment so neither a Unix-socket URI nor a password reaches argv/logs.
const pgEnvironment = { ...process.env,
 PGDATABASE: decodeURIComponent(database.pathname.slice(1)),
 PGHOST: database.searchParams.get('host') || database.hostname,
 PGPORT: database.searchParams.get('port') || database.port || '5432',
 PGUSER: database.searchParams.get('user') || decodeURIComponent(database.username),
 PGPASSWORD: database.searchParams.get('password') || decodeURIComponent(database.password),
 PGSSLMODE: database.searchParams.get('sslmode') || 'prefer',
};
const json = execFileSync('psql', ['-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c',
 "SELECT COALESCE(json_agg(t),'[]'::json) FROM (SELECT c.identity_id AS id,u.username FROM community_users c JOIN users u ON u.id=c.user_id WHERE u.username IS NOT NULL AND u.username<>'') t"],
 { env: pgEnvironment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16*1024*1024 });
const { PrismaClient } = require('@prisma/client');
let pg;
let client;
if (process.env.DB_PROVIDER === 'pglite') {
 if (!process.env.PGLITE_DIR) throw new Error('Set PGLITE_DIR to the stopped relay database.');
 const { PGlite } = require('@electric-sql/pglite');
 const { PrismaPGlite } = require('pglite-prisma-adapter');
 pg = new PGlite(process.env.PGLITE_DIR); client = new PrismaClient({ adapter: new PrismaPGlite(pg) });
} else { client = new PrismaClient(); }
try {
 const records = JSON.parse(json);
 await client.$transaction(async tx => {
  for (const record of records) {
   if (typeof record.id !== 'string' || !/^[a-z0-9_]{3,20}$/.test(record.username)) throw new Error('Invalid legacy username; migration aborted.');
   const identity = await tx.communityIdentity.findUnique({ where: { id: record.id } });
   if (!identity || (identity.username && identity.username !== record.username)) throw new Error('Identity conflict; migration aborted without changes.');
   await tx.communityIdentity.update({ where: { id: record.id }, data: { username: record.username } });
  }
 });
 console.log(`Reserved ${records.length} existing usernames without changing identity IDs.`);
} catch { throw new Error('Username migration failed; no changes committed. Inspect mappings privately before rollout.'); }
finally { await client.$disconnect(); if (pg) await pg.close(); }
