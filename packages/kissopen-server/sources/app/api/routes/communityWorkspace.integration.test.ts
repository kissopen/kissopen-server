import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import { encodeHex } from 'privacy-kit';
import fastify from 'fastify';
import { validatorCompiler, serializerCompiler } from 'fastify-type-provider-zod';
import { communityWorkspaceDeliveryMessage } from '@kissopen/kissopen-wire';
import { securityHash, securityToken } from '@/app/auth/communitySecurityCrypto';
import type { Fastify } from '../types';

describe('same-account encrypted workspace handoff', () => {
    let app: Fastify, db: typeof import('@/storage/db')['db'];
    let pg: ReturnType<typeof import('@/storage/db')['getPGlite']>;
    let desktop: string, phone: string, stranger: string;
    const key = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
    const encoded = (value: Uint8Array) => Buffer.from(value).toString('base64');
    const call = async (path: string, token: string, body?: object) => {
        const result = await app.inject({ method: body ? 'POST' : 'GET', url: '/v1/community/workspace' + path,
            headers: { authorization: 'Bearer ' + token }, ...(body ? { payload: body } : {}) });
        return { status: result.statusCode, body: result.json() };
    };
    beforeAll(async () => {
        vi.stubEnv('DB_PROVIDER', 'pglite');
        vi.stubEnv('HANDY_MASTER_SECRET', 'test-only-workspace-master-secret-with-no-production-use');
        vi.stubEnv('PGLITE_DIR', mkdtempSync(join(tmpdir(), 'kissopen-workspace-test-')));
        const storage = await import('@/storage/db'); db = storage.db; pg = storage.getPGlite();
        for (const directory of readdirSync('prisma/migrations').sort()) {
            if (!directory.includes('.')) await pg!.exec(readFileSync(join('prisma/migrations', directory, 'migration.sql'), 'utf8'));
        }
        // This test never issues real relay credentials or touches a user's keyring.
        vi.spyOn((await import('@/app/auth/auth')).auth, 'createToken').mockResolvedValue('test-only-relay-token');
        app = fastify({ logger: false }).withTypeProvider() as Fastify;
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        (await import('./communityWorkspaceRoutes')).communityWorkspaceRoutes(app);
        (await import('./authRoutes')).authRoutes(app);
        const owner = await db.communityIdentity.create({ data: { provider: 'nodeloc', subject: 'test-owner', name: 'Owner' } });
        const other = await db.communityIdentity.create({ data: { provider: 'github', subject: 'test-other', name: 'Other' } });
        desktop = securityToken(); phone = securityToken(); stranger = securityToken();
        await db.communityAccountSession.createMany({ data: [
            { identityId: owner.id, tokenHash: securityHash(desktop), expiresAt: new Date(Date.now() + 3600000) },
            { identityId: owner.id, tokenHash: securityHash(phone), expiresAt: new Date(Date.now() + 3600000) },
            { identityId: other.id, tokenHash: securityHash(stranger), expiresAt: new Date(Date.now() + 3600000) },
        ] });
    }, 30000);
    afterAll(async () => { await app?.close(); await db?.$disconnect(); await pg?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
    it('binds first device, consumes its proof once and preserves the key', async () => {
        const ticket = await call('/open', desktop, { recipientKey: encoded(nacl.box.keyPair().publicKey) });
        expect(ticket.body.publicKey).toBeNull();
        const proof = { publicKey: encoded(key.publicKey), signature: encoded(nacl.sign.detached(Buffer.from(ticket.body.challenge, 'base64url'), key.secretKey)) };
        expect((await call('/' + ticket.body.id + '/complete', desktop, proof)).status).toBe(200);
        expect((await call('/' + ticket.body.id + '/complete', desktop, proof)).status).toBe(410);
    });
    it('delivers only same-account signed ciphertext to the requesting session', async () => {
        const ticket = (await call('/open', phone, { recipientKey: encoded(nacl.box.keyPair().publicKey) })).body;
        expect(ticket.publicKey).toBe(Buffer.from(key.publicKey).toString('hex'));
        expect((await call('/requests', stranger)).body.requests).toHaveLength(0);
        expect((await call('/' + ticket.id, stranger)).status).toBe(410);
        const envelope = encoded(new Uint8Array(104).fill(9));
        const signature = encoded(nacl.sign.detached(new TextEncoder().encode(communityWorkspaceDeliveryMessage(ticket, envelope)), key.secretKey));
        expect((await call('/' + ticket.id + '/deliver', stranger, { envelope, signature })).status).toBe(410);
        expect((await call('/' + ticket.id + '/deliver', desktop, { envelope, signature: encoded(new Uint8Array(64)) })).status).toBe(403);
        expect((await call('/' + ticket.id + '/deliver', desktop, { envelope, signature })).status).toBe(200);
        expect((await call('/' + ticket.id, phone)).body.envelope).toBe(envelope);
        expect((await call('/requests', desktop)).body.requests).toHaveLength(0);
        const replacement = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8));
        expect((await call('/' + ticket.id + '/complete', phone, { publicKey: encoded(replacement.publicKey),
            signature: encoded(nacl.sign.detached(Buffer.from(ticket.challenge, 'base64url'), replacement.secretKey)) })).status).toBe(409);
    });
    it('rejects expired requests and revoked account sessions', async () => {
        const ticket = (await call('/open', phone, { recipientKey: encoded(nacl.box.keyPair().publicKey) })).body;
        await db.communityWorkspaceTransfer.update({ where: { id: ticket.id }, data: { expiresAt: new Date(0) } });
        expect((await call('/' + ticket.id, phone)).status).toBe(410);
        await db.communityAccountSession.delete({ where: { tokenHash: securityHash(phone) } });
        expect((await call('/requests', phone)).status).toBe(401);
    });
    it('never replaces an old binding, migrates only its matching seed and restores without a peer', async () => {
        const recipient = nacl.box.keyPair();
        const before = await call('/session', desktop, { recipientKey: encoded(recipient.publicKey) });
        expect(before.body).toMatchObject({ status: 'restore_required', publicKey: Buffer.from(key.publicKey).toString('hex') });
        expect((await call('/escrow', desktop, { secret: Buffer.from(new Uint8Array(32).fill(8)).toString('base64url') })).status).toBe(409);
        expect((await call('/escrow', stranger, { secret: Buffer.from(new Uint8Array(32).fill(7)).toString('base64url') })).status).toBe(409);
        expect((await call('/escrow', desktop, { secret: Buffer.from(new Uint8Array(32).fill(7)).toString('base64url') })).status).toBe(200);
        const restored = await call('/session', desktop, { recipientKey: encoded(recipient.publicKey) });
        expect(restored.status).toBe(200); expect(restored.body.status).toBe('ready');
        const envelope = Buffer.from(restored.body.envelope, 'base64');
        expect(nacl.box.open(envelope.subarray(56), envelope.subarray(32, 56), envelope.subarray(0, 32), recipient.secretKey))
            .toEqual(new Uint8Array(32).fill(7));
        expect((await call('/session', phone, { recipientKey: encoded(recipient.publicKey) })).status).toBe(401);
        const stored = await db.communityIdentity.findFirstOrThrow({ where: { subject: 'test-owner' } });
        expect(stored.workspaceSeedEncrypted).toMatch(/^v1:/);
        expect(stored.workspaceSeedEncrypted).not.toContain(Buffer.from(new Uint8Array(32).fill(7)).toString('base64url'));
    });
    it('creates exactly one account key across concurrent first logins and preserves it on master-key failure', async () => {
        const identity = await db.communityIdentity.create({ data: { provider: 'github', subject: 'test-escrow', name: 'Escrow' } });
        const token = securityToken();
        await db.communityAccountSession.create({ data: { identityId: identity.id, tokenHash: securityHash(token), expiresAt: new Date(Date.now() + 3600000) } });
        const recipient = nacl.box.keyPair();
        const sessions = await Promise.all(Array.from({ length: 3 }, () => call('/session', token, { recipientKey: encoded(recipient.publicKey) })));
        expect(sessions.map(s => s.status)).toEqual([200, 200, 200]);
        expect(new Set(sessions.map(s => s.body.publicKey)).size).toBe(1);
        const original = await db.communityIdentity.findUniqueOrThrow({ where: { id: identity.id } });
        vi.stubEnv('HANDY_MASTER_SECRET', 'different-test-only-master-secret-with-no-production-use');
        const unavailable = await call('/session', token, { recipientKey: encoded(recipient.publicKey) });
        expect(unavailable.status).toBe(503);
        expect(unavailable.body.error).toContain('Existing data was preserved');
        const after = await db.communityIdentity.findUniqueOrThrow({ where: { id: original.id } });
        expect(after.accountId).toBe(original.accountId);
        expect(after.workspaceSeedEncrypted).toBe(original.workspaceSeedEncrypted);
        vi.stubEnv('HANDY_MASTER_SECRET', 'test-only-workspace-master-secret-with-no-production-use');
        await db.communityIdentity.update({ where: { id: after.id }, data: { workspaceSeedEncrypted: original.workspaceSeedEncrypted!.slice(0, -1) + '!' } });
        expect((await call('/session', token, { recipientKey: encoded(recipient.publicKey) })).status).toBe(503);
        await db.communityIdentity.update({ where: { id: after.id }, data: { workspaceSeedEncrypted: original.workspaceSeedEncrypted } });
        expect((await call('/session', token, { recipientKey: encoded(recipient.publicKey) })).status).toBe(200);
    });
    it('decodes Agent authorization server-side and refuses unregistered or cross-account requests', async () => {
        const pairKey = nacl.box.keyPair().publicKey;
        const authorization = 'kissopen://terminal?' + Buffer.from(pairKey).toString('base64url');
        expect((await call('/pair', desktop, { authorization })).status).toBe(410);
        const requested = await app.inject({ method: 'POST', url: '/v1/auth/request', payload: { publicKey: encoded(pairKey), supportsV2: true } });
        expect(requested.statusCode).toBe(200);
        expect(requested.json().state).toBe('requested');
        expect((await call('/pair', desktop, { authorization })).body.recipientKey).toBe(encoded(pairKey));
        const envelope = encoded(new Uint8Array(105).fill(5));
        expect((await call('/pair', desktop, { authorization, envelope })).status).toBe(200);
        expect((await call('/pair', stranger, { authorization, envelope })).status).toBe(409);
        const stored = await db.terminalAuthRequest.findUniqueOrThrow({ where: { publicKey: encodeHex(Uint8Array.from(pairKey)) } });
        expect(stored.response).toBe(envelope);
        const authorized = await app.inject({ method: 'POST', url: '/v1/auth/request', payload: { publicKey: encoded(pairKey), supportsV2: true } });
        expect(authorized.json()).toMatchObject({ state: 'authorized', response: envelope });
        expect((await call('/session', stranger, { recipientKey: encoded(nacl.box.keyPair().publicKey) })).status).toBe(200);
        expect((await call('/pair', stranger, { authorization, envelope })).status).toBe(410);
        await db.terminalAuthRequest.update({ where: { id: stored.id }, data: { createdAt: new Date(Date.now() - 121000) } });
        expect((await call('/pair', desktop, { authorization })).status).toBe(410);
        await db.terminalAuthRequest.update({ where: { id: stored.id }, data: { createdAt: new Date(), supportsV2: false } });
        expect((await call('/pair', desktop, { authorization })).status).toBe(410);
    });
    it('round-trips binary device keys through PGlite, including transactions and existing-device reads', async () => {
        const owner = await db.communityIdentity.findFirstOrThrow({ where: { subject: 'test-owner' } });
        const bytes = new Uint8Array([0, 1, 127, 128, 254, 255]);
        const created = await db.machine.create({ data: { id: 'binary-device', accountId: owner.accountId!, metadata: 'encrypted-test-metadata', dataEncryptionKey: bytes } });
        expect(created.dataEncryptionKey).toEqual(bytes);
        const existing = await db.machine.findFirstOrThrow({ where: { id: created.id, accountId: owner.accountId! } });
        expect(existing.dataEncryptionKey).toEqual(bytes);
        const replacement = new Uint8Array([255, 0, 128, 1]);
        const updated = await db.$transaction(async tx => {
            await tx.machine.update({ where: { id: created.id }, data: { dataEncryptionKey: replacement } });
            return tx.machine.findUniqueOrThrow({ where: { id: created.id } });
        });
        expect(updated.dataEncryptionKey).toEqual(replacement);
        expect((await db.machine.findMany({ where: { accountId: owner.accountId! } }))[0].dataEncryptionKey).toEqual(replacement);
        await db.machine.update({ where: { id: created.id }, data: { dataEncryptionKey: null } });
        expect((await db.machine.findUniqueOrThrow({ where: { id: created.id } })).dataEncryptionKey).toBeNull();
    });
});
