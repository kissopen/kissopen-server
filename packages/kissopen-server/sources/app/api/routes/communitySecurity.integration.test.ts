import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fastify from 'fastify';
import { validatorCompiler, serializerCompiler } from 'fastify-type-provider-zod';
import type { Fastify } from '../types';
import { securityHash, securityToken, totpCode } from '@/app/auth/communitySecurityCrypto';

vi.mock('@/app/auth/communityProviders', () => ({
    communityPublicOrigin: () => 'http://localhost',
    communityProviderConfig: (provider: string) => ({ pkce: true, clientId: 'test-only', clientSecret: 'test-only', redirectUri: `http://localhost/v1/community/auth/${provider}/callback`, authorize: 'https://provider.invalid/authorize', scope: 'profile' }),
    communityProviderIdentity: async (provider: string, code: string) => ({ subject: code, name: 'Test user ' + provider }),
}));

describe('account security real database and HTTP boundaries', () => {
    let app: Fastify;
    let db: typeof import('@/storage/db')['db'];
    let pg: ReturnType<typeof import('@/storage/db')['getPGlite']>;
    let owner: string, other: string, ownerToken: string, otherToken: string;
    let codes: string[];
    let setupSecret: string;
    let setupStep: number;
    const password = 'test-only-correct-password';
    const call = async (path: string, body?: object, token?: string) => {
        const result = await app.inject({ method: body ? 'POST' : 'GET', url: '/v1/community/' + path,
            headers: token ? { authorization: `Bearer ${token}` } : {}, ...(body ? { payload: body } : {}) });
        return { status: result.statusCode, body: result.json() };
    };
    const proof = async (token = ownerToken, withPassword = true, code?: string) => {
        const result = await call('security/verify', { ...(withPassword ? { password } : {}), ...(code ? { code } : {}) }, token);
        expect(result.status).toBe(200); return result.body.proof as string;
    };
    const oauth = async (provider: string, subject: string, token?: string, intent?: string, securityProof?: string) => {
        const start = await call(token ? 'security/oauth/start' : 'auth/start', { provider, ...(intent ? { intent } : {}), ...(securityProof ? { proof: securityProof } : {}) }, token);
        expect(start.status).toBe(200);
        const target = new URL(start.body.authorizationUrl);
        const authorization = await app.inject({ url: target.pathname + target.search });
        const cookie = authorization.headers['set-cookie'] as string;
        const callback = await app.inject({ url: `/v1/community/auth/${provider}/callback?state=${target.searchParams.get('state')}&code=${subject}`, headers: { cookie: cookie.split(';')[0] } });
        expect(callback.statusCode).toBe(200);
        return start.body;
    };
    beforeAll(async () => {
        vi.stubEnv('DB_PROVIDER', 'pglite');
        vi.stubEnv('PGLITE_DIR', mkdtempSync(join(tmpdir(), 'kissopen-security-test-')));
        vi.stubEnv('HANDY_MASTER_SECRET', 'test-only-no-production-secret'.repeat(3));
        const storage = await import('@/storage/db');
        db = storage.db;
        pg = storage.getPGlite();
        const migrations = join(process.cwd(), 'prisma/migrations');
        for (const directory of readdirSync(migrations).sort()) {
            if (directory.includes('.')) continue;
            if (directory === '20261006120000_account_security') {
                await pg!.exec(`INSERT INTO "Account"("id","publicKey","updatedAt") VALUES ('legacy-workspace','${'ab'.repeat(32)}',now());
                    INSERT INTO "CommunityIdentity"("id","provider","subject","name","accountId","updatedAt") VALUES ('legacy-identity','github','legacy-subject','Legacy','legacy-workspace',now());`);
            }
            await pg!.exec(readFileSync(join(migrations, directory, 'migration.sql'), 'utf8'));
        }
        app = fastify({ logger: false }).withTypeProvider() as Fastify;
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        const { communityAuthRoutes } = await import('./communityAuthRoutes');
        const { communitySecurityRoutes } = await import('./communitySecurityRoutes');
        communityAuthRoutes(app); communitySecurityRoutes(app);
        await app.ready();
        const first = await db.communityIdentity.create({ data: { provider: 'nodeloc', subject: 'owner', name: 'Owner', bindings: { create: { provider: 'nodeloc', subject: 'owner' } } } });
        const second = await db.communityIdentity.create({ data: { provider: 'nodeloc', subject: 'other', name: 'Other', bindings: { create: { provider: 'nodeloc', subject: 'other' } } } });
        owner = first.id; other = second.id; ownerToken = securityToken(); otherToken = securityToken();
        await db.communityAccountSession.createMany({ data: [{ identityId: owner, tokenHash: securityHash(ownerToken), expiresAt: new Date(Date.now() + 3600000) }, { identityId: other, tokenHash: securityHash(otherToken), expiresAt: new Date(Date.now() + 3600000) }] });
    }, 30000);
    afterAll(async () => { await app?.close(); await db?.$disconnect(); await pg?.close(); vi.unstubAllEnvs(); });

    it('backfills OAuth bindings without changing existing identity or workspace keys', async () => {
        const legacy = await db.communityIdentity.findUniqueOrThrow({ where: { id: 'legacy-identity' }, include: { account: true, bindings: true } });
        expect(legacy.account?.publicKey).toBe('ab'.repeat(32));
        expect(legacy.bindings[0].identityId).toBe(legacy.id);
        expect(legacy.passwordHash).toBe(null);
    });

    it('rejects provider ownership changes between binding lookup and identity lock', async () => {
        const security = await import('@/app/auth/communitySecurity');
        const originalLock = security.lockedIdentity;
        const lock = vi.spyOn(security, 'lockedIdentity').mockImplementationOnce(async (tx, id) => {
            // Simulate a provider being unlinked and bound to a different account
            // after the callback's initial lookup, before it acquires the lock.
            await tx.communityOAuthBinding.update({ where: { provider_subject: { provider: 'github', subject: 'legacy-subject' } }, data: { identityId: other } });
            return originalLock(tx, id);
        });
        try {
            const login = await oauth('github', 'legacy-subject');
            const status = await call(`auth/${login.id}/status`, undefined, login.pollToken);
            expect(status.body.status).toBe('failed');
            expect((await call(`auth/${login.id}/complete`, { mode: 'identity' }, login.pollToken)).status).toBe(401);
        } finally { lock.mockRestore(); }
    });

    it('requires authentication, binds one-use proofs to sessions and prevents removing the last method', async () => {
        expect((await call('security')).status).toBe(401);
        const p = await proof(ownerToken, false);
        expect((await call('security/username', { proof: p, username: 'hijack' }, otherToken)).status).toBe(403);
        expect((await call('security/username', { proof: p, username: 'owner_name' }, ownerToken)).status).toBe(200);
        expect((await call('security/username', { proof: p, username: 'reuse' }, ownerToken)).status).toBe(403);
        expect((await call('security/oauth/unlink', { proof: await proof(otherToken, false), provider: 'nodeloc' }, otherToken)).status).toBe(409);
    });
    it('sets a salted password without changing identity and protects completion from reuse', async () => {
        expect((await call('security/password', { proof: await proof(ownerToken, false), password }, ownerToken)).status).toBe(200);
        const identity = await db.communityIdentity.findUniqueOrThrow({ where: { id: owner } });
        expect(identity.passwordHash).not.toContain(password);
        expect((await call('auth/password', { username: 'owner_name', password: 'wrong' })).status).toBe(400);
        const login = await call('auth/password', { username: 'OWNER_NAME', password });
        expect(login.status).toBe(200);
        const completed = await call(`auth/${login.body.id}/complete`, { mode: 'identity' }, login.body.pollToken);
        expect(completed.status).toBe(200); expect(completed.body.profile.id).toBe(owner);
        expect((await call(`auth/${login.body.id}/complete`, { mode: 'identity' }, login.body.pollToken)).status).toBe(401);
    }, 15000);
    it('enables MFA only with a valid code and revokes earlier sessions', async () => {
        const setup = await call('security/totp/begin', { proof: await proof() }, ownerToken);
        setupSecret = setup.body.secret; setupStep = Math.floor(Date.now() / 30000);
        expect(setup.status).toBe(200);
        const incorrectCode = ((Number(totpCode(setupSecret, setupStep)) + 1) % 1000000).toString().padStart(6, '0');
        expect((await call('security/totp/confirm', { setupToken: setup.body.setupToken, code: incorrectCode }, ownerToken)).status).toBe(400);
        expect((await call('security', undefined, ownerToken)).body.totpEnabled).toBe(false);
        const enabled = await call('security/totp/confirm', { setupToken: setup.body.setupToken, code: totpCode(setup.body.secret, Math.floor(Date.now() / 30000)) }, ownerToken);
        expect(enabled.status).toBe(200); codes = enabled.body.codes; expect(codes.length).toBe(10);
        expect(await db.communityAccountSession.count({ where: { identityId: owner } })).toBe(1);
        const identity = await db.communityIdentity.findUniqueOrThrow({ where: { id: owner } });
        expect(identity.totpSecret).not.toBe(setup.body.secret);
    }, 15000);
    it('requires MFA on both password and OAuth; recovery codes cannot be replayed', async () => {
        const login = await call('auth/password', { username: 'owner_name', password });
        expect((await call(`auth/${login.body.id}/status`, undefined, login.body.pollToken)).body.status).toBe('second_factor');
        expect((await call(`auth/${login.body.id}/complete`, { mode: 'identity' }, login.body.pollToken)).status).toBe(401);
        expect((await call(`auth/${login.body.id}/factor`, { code: totpCode(setupSecret, setupStep) }, login.body.pollToken)).status).toBe(400);
        expect((await call(`auth/${login.body.id}/factor`, { code: codes[0] }, login.body.pollToken)).status).toBe(200);
        const social = await oauth('nodeloc', 'owner');
        expect((await call(`auth/${social.id}/status`, undefined, social.pollToken)).body.status).toBe('second_factor');
        expect((await call(`auth/${social.id}/factor`, { code: codes[0] }, social.pollToken)).status).toBe(400);
        expect((await call(`auth/${social.id}/factor`, { code: codes[1] }, social.pollToken)).status).toBe(200);
        expect((await call(`auth/${social.id}/complete`, { mode: 'identity' }, social.pollToken)).body.profile.id).toBe(owner);
        expect((await call('security', undefined, ownerToken)).body.recoveryCodesRemaining).toBe(8);
    }, 15000);
    it('expires proofs and requires OAuth reauthentication for old provider-only sessions', async () => {
        const p = await proof(otherToken, false);
        await db.communitySecurityProof.update({ where: { tokenHash: securityHash(p) }, data: { expiresAt: new Date(Date.now() - 1000) } });
        expect((await call('security/username', { proof: p, username: 'expired_proof' }, otherToken)).status).toBe(403);
        await db.communityAccountSession.update({ where: { tokenHash: securityHash(otherToken) }, data: { createdAt: new Date(Date.now() - 3600000) } });
        expect((await call('security/verify', {}, otherToken)).status).toBe(403);
        const reauth = await oauth('nodeloc', 'other', otherToken, 'reauthenticate');
        const result = await call('security/oauth/complete', { id: reauth.id, pollToken: reauth.pollToken }, otherToken);
        expect(result.status).toBe(200);
        expect((await call('security/username', { proof: result.body.proof, username: 'other_name' }, otherToken)).status).toBe(200);
    });
    it('does not disclose credential material and atomically consumes a recovery code under concurrent requests', async () => {
        const first = await call('auth/password', { username: 'owner_name', password });
        const second = await call('auth/password', { username: 'owner_name', password });
        const results = await Promise.all([first, second].map(login => call(`auth/${login.body.id}/factor`, { code: codes[5] }, login.body.pollToken)));
        expect(results.map(result => result.status).sort()).toEqual([200, 400]);
        const state = await call('security', undefined, ownerToken);
        expect(Object.keys(state.body).sort()).toEqual(['passwordEnabled', 'providers', 'recoveryCodesRemaining', 'totpEnabled', 'username']);
        expect(JSON.stringify(state.body)).not.toContain(password);
        expect(JSON.stringify(state.body)).not.toContain(setupSecret);
    }, 15000);
    it('revokes unfinished authorization when its initiating session signs out', async () => {
        const token = securityToken();
        await db.communityAccountSession.create({ data: { identityId: owner, tokenHash: securityHash(token), expiresAt: new Date(Date.now() + 3600000) } });
        const start = await call('security/oauth/start', { provider: 'google', intent: 'link', proof: await proof(token, true, codes[6]) }, token);
        expect(start.status).toBe(200);
        const target = new URL(start.body.authorizationUrl);
        const authorization = await app.inject({ url: target.pathname + target.search });
        await app.inject({ method: 'DELETE', url: '/v1/community/account/session', headers: { authorization: `Bearer ${token}` } });
        const callback = await app.inject({ url: `/v1/community/auth/google/callback?state=${target.searchParams.get('state')}&code=owner-google`, headers: { cookie: (authorization.headers['set-cookie'] as string).split(';')[0] } });
        expect(callback.statusCode).toBe(400);
        expect(await db.communityOAuthBinding.count({ where: { identityId: owner, provider: 'google' } })).toBe(0);
        expect((await call('security', undefined, token)).status).toBe(401);
    }, 15000);
    it('throttles unknown username attempts without creating an authorization/session', async () => {
        for (let i = 0; i < 10; i++) expect((await call('auth/password', { username: 'missing_user', password: 'incorrect' })).status).toBe(400);
        expect((await call('auth/password', { username: 'missing_user', password: 'incorrect' })).status).toBe(429);
        expect(await db.communityIdentity.count({ where: { username: 'missing_user' } })).toBe(0);
    }, 15000);
    it('links providers without changing account, refuses linking another account and scopes OAuth reauthentication', async () => {
        const link = await oauth('github', 'owner-github', ownerToken, 'link', await proof(ownerToken, true, codes[2]));
        expect((await call(`auth/${link.id}/status`, undefined, link.pollToken)).body.status).toBe('linked');
        expect((await db.communityOAuthBinding.findUniqueOrThrow({ where: { provider_subject: { provider: 'github', subject: 'owner-github' } } })).identityId).toBe(owner);
        const conflict = await oauth('nodeloc', 'other', ownerToken, 'link', await proof(ownerToken, true, codes[3]));
        expect((await call(`auth/${conflict.id}/status`, undefined, conflict.pollToken)).body.status).toBe('failed');
        const reauth = await oauth('github', 'owner-github', ownerToken, 'reauthenticate');
        expect((await call(`auth/${reauth.id}/factor`, { code: codes[4] }, reauth.pollToken)).status).toBe(200);
        expect((await call(`auth/${reauth.id}/complete`, { mode: 'identity' }, reauth.pollToken)).status).toBe(401);
        const p = await call('security/oauth/complete', { id: reauth.id, pollToken: reauth.pollToken }, ownerToken);
        expect(p.status).toBe(200);
        expect((await call('security/oauth/complete', { id: reauth.id, pollToken: reauth.pollToken }, ownerToken)).status).toBe(403);
        expect((await call('security/oauth/unlink', { proof: p.body.proof, provider: 'github' }, ownerToken)).status).toBe(200);
        expect(await db.communityOAuthBinding.count({ where: { identityId: owner, provider: 'github' } })).toBe(0);
        expect((await db.communityIdentity.findUniqueOrThrow({ where: { id: other } })).name).toBe('Other');
    }, 15000);
});
