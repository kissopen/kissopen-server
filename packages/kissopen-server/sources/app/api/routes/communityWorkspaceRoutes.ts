import { randomBytes } from 'node:crypto';
import nacl from 'tweetnacl';
import { z } from 'zod';
import { encodeHex } from 'privacy-kit';
import {
    CommunityWorkspaceOpenSchema, CommunityWorkspaceTicketSchema,
    CommunityWorkspaceStateSchema, CommunityWorkspaceProofSchema,
    CommunityWorkspaceResultSchema, CommunityWorkspaceDeliverySchema,
    CommunityWorkspaceRequestsSchema, CommunityWorkspacePairSchema,
    CommunityWorkspacePairResultSchema, communityWorkspaceDeliveryMessage,
    CommunityWorkspaceSessionRequestSchema, CommunityWorkspaceSessionSchema,
    CommunityWorkspaceEscrowRequestSchema, CommunityWorkspaceEscrowResultSchema,
} from '@kissopen/kissopen-wire';
import { db } from '@/storage/db';
import { auth } from '@/app/auth/auth';
import { securitySession, SecurityProblem, lockedIdentity, throttle } from '@/app/auth/communitySecurity';
import { workspaceSeedOpen, workspaceSeedSeal } from '@/app/auth/communityWorkspaceEscrow';
import type { Prisma } from '@prisma/client';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import type { Fastify } from '../types';

const params = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{43}$/) });
const random = () => randomBytes(32).toString('base64url');
const ticket = (row: { id: string; recipientKey: string; workspacePublicKey: string | null; challenge: string; expiresAt: Date }) =>
    ({ id: row.id, recipientKey: row.recipientKey, publicKey: row.workspacePublicKey, challenge: row.challenge, expiresAt: row.expiresAt.toISOString() });
async function liveSession(tx: Prisma.TransactionClient, hash: string) {
    const session = await tx.communityAccountSession.findUnique({ where: { tokenHash: hash } });
    if (!session || session.expiresAt.getTime() <= Date.now()) throw new SecurityProblem(401, 'Sign in again. / 请重新登录。');
    return session;
}
function verify(message: Uint8Array, signature: string, publicKey: string) {
    if (!nacl.sign.detached.verify(message, Buffer.from(signature, 'base64'), Buffer.from(publicKey, 'hex')))
        throw new SecurityProblem(403, 'Workspace ownership could not be verified. / 工作区身份验证失败。');
}

export function communityWorkspaceRoutes(app: Fastify) {
    const options = { logLevel: 'silent' as const, bodyLimit: 4096,
        // Preserve deliberate user-facing errors; never return database/crypto
        // diagnostics or submitted keys through the global generic handler.
        errorHandler(error: FastifyError, _request: FastifyRequest, reply: FastifyReply) {
            reply.header('Cache-Control', 'no-store');
            if (error instanceof SecurityProblem) return reply.code(error.status).send({ error: error.message });
            const status = error.statusCode ?? 500;
            return reply.code(status).send({ error: status >= 500
                ? 'Workspace connection is temporarily unavailable. Your data is unchanged. / 暂时无法连接工作区，数据未被修改。'
                : 'Workspace request could not be verified. Please try again. / 无法验证工作区请求，请重试。' });
        },
    };
    app.addHook('onSend', async (request, reply) => {
        if (request.url.startsWith('/v1/community/workspace/')) reply.header('Cache-Control', 'no-store');
    });
    app.post('/v1/community/workspace/session', { ...options, schema: { body: CommunityWorkspaceSessionRequestSchema,
        response: { 200: CommunityWorkspaceSessionSchema } } }, async request => {
        const session = await securitySession(request.headers.authorization);
        await throttle(`workspace-session:${session.identityId}`, 240);
        return db.$transaction(async tx => {
            const identity = await lockedIdentity(tx, session.identityId);
            await liveSession(tx, session.tokenHash);
            let account = identity.accountId ? await tx.account.findUniqueOrThrow({ where: { id: identity.accountId } }) : null;
            if (account && await tx.communityIdentity.count({ where: { accountId: account.id, id: { not: identity.id } } }))
                throw new SecurityProblem(409, 'Workspace belongs to another identity.');
            if (account && !identity.workspaceSeedEncrypted)
                return { status: 'restore_required' as const, identityId: identity.id, publicKey: account.publicKey };
            let seed: Uint8Array | undefined, privateKey: Uint8Array | undefined;
            try {
                if (identity.workspaceSeedEncrypted) {
                    if (!account) throw new SecurityProblem(503, 'Workspace binding is incomplete. Existing data was preserved.');
                    seed = workspaceSeedOpen(identity.workspaceSeedEncrypted, identity.id, account.id, account.publicKey);
                } else {
                    seed = randomBytes(32);
                }
                const signing = nacl.sign.keyPair.fromSeed(seed); privateKey = signing.secretKey;
                const publicKey = Buffer.from(signing.publicKey).toString('hex');
                if (account && account.publicKey !== publicKey) throw new SecurityProblem(503, 'Workspace key does not match. Existing data was preserved.');
                if (!account) {
                    account = await tx.account.create({ data: { publicKey } });
                    const encrypted = workspaceSeedSeal(seed, identity.id, account.id, publicKey);
                    await tx.communityIdentity.update({ where: { id: identity.id }, data: { accountId: account.id, workspaceSeedEncrypted: encrypted } });
                }
                const recipient = Buffer.from(request.body.recipientKey, 'base64');
                const ephemeral = nacl.box.keyPair(), nonce = randomBytes(24);
                let envelope: string;
                try {
                    envelope = Buffer.concat([ephemeral.publicKey, nonce, nacl.box(seed, nonce, recipient, ephemeral.secretKey)]).toString('base64');
                } finally { ephemeral.secretKey.fill(0); }
                return { status: 'ready' as const, identityId: identity.id, publicKey, envelope, workspaceToken: await auth.createToken(account.id) };
            } finally { seed?.fill(0); privateKey?.fill(0); }
        });
    });
    // A device with an existing seed may migrate it, but neither a new seed nor
    // a mismatching account key may replace an established workspace binding.
    app.post('/v1/community/workspace/escrow', { ...options, schema: { body: CommunityWorkspaceEscrowRequestSchema,
        response: { 200: CommunityWorkspaceEscrowResultSchema } } }, async request => {
        const session = await securitySession(request.headers.authorization);
        await throttle(`workspace-escrow:${session.identityId}`, 30);
        const seed = Buffer.from(request.body.secret, 'base64url');
        let privateKey: Uint8Array | undefined;
        try {
            const signing = nacl.sign.keyPair.fromSeed(seed); privateKey = signing.secretKey;
            const publicKey = Buffer.from(signing.publicKey).toString('hex');
            return await db.$transaction(async tx => {
                const identity = await lockedIdentity(tx, session.identityId);
                await liveSession(tx, session.tokenHash);
                if (!identity.accountId) throw new SecurityProblem(409, 'Connect the account workspace first.');
                const account = await tx.account.findUniqueOrThrow({ where: { id: identity.accountId } });
                if (account.publicKey !== publicKey) throw new SecurityProblem(409, 'This key does not belong to this account. Existing history was preserved. / 密钥不属于此账号，原历史已保留。');
                if (await tx.communityIdentity.count({ where: { accountId: account.id, id: { not: identity.id } } }))
                    throw new SecurityProblem(409, 'Workspace belongs to another identity.');
                if (identity.workspaceSeedEncrypted) {
                    const original = workspaceSeedOpen(identity.workspaceSeedEncrypted, identity.id, account.id, publicKey);
                    try {
                        if (!original.equals(seed)) throw new SecurityProblem(409, 'Workspace key conflict. Existing history was preserved.');
                    } finally { original.fill(0); }
                } else {
                    await tx.communityIdentity.update({ where: { id: identity.id }, data: {
                        workspaceSeedEncrypted: workspaceSeedSeal(seed, identity.id, account.id, publicKey),
                    } });
                }
                return { identityId: identity.id, publicKey };
            });
        } finally { seed.fill(0); privateKey?.fill(0); }
    });
    app.post('/v1/community/workspace/open', { ...options, schema: { body: CommunityWorkspaceOpenSchema, response: { 200: CommunityWorkspaceTicketSchema } } }, async request => {
        const session = await securitySession(request.headers.authorization);
        await throttle(`workspace-open:${session.identityId}`, 60);
        return db.$transaction(async tx => {
            const identity = await lockedIdentity(tx, session.identityId);
            await liveSession(tx, session.tokenHash);
            await tx.communityWorkspaceTransfer.deleteMany({ where: { OR: [{ expiresAt: { lte: new Date() } }, { sessionHash: session.tokenHash }] } });
            const account = identity.accountId ? await tx.account.findUniqueOrThrow({ where: { id: identity.accountId } }) : null;
            const row = await tx.communityWorkspaceTransfer.create({ data: {
                id: random(), identityId: identity.id, sessionHash: session.tokenHash,
                recipientKey: request.body.recipientKey, workspacePublicKey: account?.publicKey ?? null,
                challenge: random(), expiresAt: new Date(Date.now() + 120000),
            } });
            return ticket(row);
        });
    });
    app.get('/v1/community/workspace/requests', { ...options, schema: { response: { 200: CommunityWorkspaceRequestsSchema } } }, async request => {
        const session = await securitySession(request.headers.authorization);
        const account = session.identity.accountId ? await db.account.findUnique({ where: { id: session.identity.accountId } }) : null;
        if (!account) return { requests: [] };
        const rows = await db.communityWorkspaceTransfer.findMany({ where: { identityId: session.identityId,
            sessionHash: { not: session.tokenHash }, workspacePublicKey: account.publicKey, envelope: null, expiresAt: { gt: new Date() } }, take: 16 });
        return { requests: rows.map(ticket) };
    });
    app.get('/v1/community/workspace/:id', { ...options, schema: { params, response: { 200: CommunityWorkspaceStateSchema } } }, async request => {
        const session = await securitySession(request.headers.authorization);
        const row = await db.communityWorkspaceTransfer.findFirst({ where: { id: request.params.id, sessionHash: session.tokenHash, identityId: session.identityId, expiresAt: { gt: new Date() } } });
        if (!row) throw new SecurityProblem(410, 'Connection request expired. Try signing in again. / 连接请求已过期，请重试。');
        return { ...ticket(row), envelope: row.envelope };
    });
    app.post('/v1/community/workspace/:id/deliver', { ...options, schema: { params, body: CommunityWorkspaceDeliverySchema } }, async request => {
        const session = await securitySession(request.headers.authorization);
        await db.$transaction(async tx => {
            const identity = await lockedIdentity(tx, session.identityId);
            await liveSession(tx, session.tokenHash);
            const row = await tx.communityWorkspaceTransfer.findFirst({ where: { id: request.params.id, identityId: identity.id, expiresAt: { gt: new Date() }, envelope: null } });
            if (!row || row.sessionHash === session.tokenHash || !identity.accountId) throw new SecurityProblem(410, 'Device request is no longer available.');
            await liveSession(tx, row.sessionHash);
            const account = await tx.account.findUniqueOrThrow({ where: { id: identity.accountId } });
            if (row.workspacePublicKey !== account.publicKey) throw new SecurityProblem(409, 'Workspace changed.');
            verify(new TextEncoder().encode(communityWorkspaceDeliveryMessage(ticket(row), request.body.envelope)), request.body.signature, account.publicKey);
            await tx.communityWorkspaceTransfer.update({ where: { id: row.id }, data: { envelope: request.body.envelope } });
        });
        return { success: true };
    });
    app.post('/v1/community/workspace/:id/complete', { ...options, schema: { params, body: CommunityWorkspaceProofSchema, response: { 200: CommunityWorkspaceResultSchema } } }, async request => {
        const session = await securitySession(request.headers.authorization);
        const accountId = await db.$transaction(async tx => {
            const identity = await lockedIdentity(tx, session.identityId);
            await liveSession(tx, session.tokenHash);
            const row = await tx.communityWorkspaceTransfer.findFirst({ where: { id: request.params.id, identityId: identity.id, sessionHash: session.tokenHash, expiresAt: { gt: new Date() } } });
            if (!row) throw new SecurityProblem(410, 'Connection request expired.');
            const publicKey = Buffer.from(request.body.publicKey, 'base64').toString('hex');
            verify(Buffer.from(row.challenge, 'base64url'), request.body.signature, publicKey);
            if (row.workspacePublicKey && row.workspacePublicKey !== publicKey) throw new SecurityProblem(409, 'Existing workspace must be restored, not replaced.');
            let accountId = identity.accountId;
            if (accountId) {
                const account = await tx.account.findUniqueOrThrow({ where: { id: accountId } });
                if (account.publicKey !== publicKey) throw new SecurityProblem(409, 'Workspace changed. Existing history was preserved.');
            } else {
                // A key may belong to one identity only. Never merge users on key collision.
                const existing = await tx.account.findUnique({ where: { publicKey } });
                if (existing && await tx.communityIdentity.count({ where: { accountId: existing.id, id: { not: identity.id } } })) throw new SecurityProblem(409, 'Workspace already belongs to another account.');
                accountId = (existing ?? await tx.account.create({ data: { publicKey } })).id;
                await tx.communityIdentity.update({ where: { id: identity.id }, data: { accountId } });
            }
            await tx.communityWorkspaceTransfer.delete({ where: { id: row.id } });
            return accountId;
        });
        return { workspaceToken: await auth.createToken(accountId) };
    });
    // The server owns decoding the opaque Agent authorization; desktop does not
    // rebuild or inspect its protocol. Only an existing, fresh V2 request qualifies.
    app.post('/v1/community/workspace/pair', { ...options, schema: { body: CommunityWorkspacePairSchema, response: { 200: CommunityWorkspacePairResultSchema } } }, async request => {
        const session = await securitySession(request.headers.authorization);
        if (!session.identity.accountId) throw new SecurityProblem(409, 'Connect the account workspace first.');
        const match = /^kissopen:\/\/terminal\?([a-zA-Z0-9_-]{43})$/.exec(request.body.authorization);
        if (!match) throw new SecurityProblem(400, 'Unsupported Agent authorization.');
        // Match the canonical encoding written by /v1/auth/request. Hex is
        // case-sensitive in the database even though both forms decode alike.
        const publicKey = encodeHex(Buffer.from(match[1], 'base64url'));
        const pending = await db.terminalAuthRequest.findUnique({ where: { publicKey } });
        if (!pending || !pending.supportsV2 || pending.createdAt.getTime() < Date.now() - 120000 ||
            (pending.responseAccountId && pending.responseAccountId !== session.identity.accountId)) throw new SecurityProblem(410, 'Agent authorization expired.');
        if (request.body.envelope) await db.$transaction(async tx => {
            await lockedIdentity(tx, session.identityId);
            await liveSession(tx, session.tokenHash);
            await tx.terminalAuthRequest.updateMany({ where: { id: pending.id, response: null }, data: { response: request.body.envelope, responseAccountId: session.identity.accountId } });
        });
        return { recipientKey: Buffer.from(publicKey, 'hex').toString('base64') };
    });
}
