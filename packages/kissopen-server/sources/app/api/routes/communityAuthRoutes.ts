import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import nacl from 'tweetnacl';
import {
    CommunityProviderSchema, CommunityProvidersSchema, CommunityStartRequestSchema,
    CommunityStartResponseSchema, CommunityStatusSchema, CommunityCompleteRequestSchema,
    CommunityCompleteResponseSchema, CommunityProfileSchema,
    CommunityPasswordRequestSchema, CommunityLoginHandleSchema, CommunityFactorRequestSchema,
} from '@kissopen/kissopen-wire';
import { db } from '@/storage/db';
import { auth } from '@/app/auth/auth';
import { communityProviderConfig, communityProviderIdentity, communityPublicOrigin } from '@/app/auth/communityProviders';
import { communityAuthCompletionPage, communityAuthPageCsp } from '@/app/auth/communityAuthPage';
import { SecurityProblem, throttle, lockedIdentity, factorConsume } from '@/app/auth/communitySecurity';
import { passwordMatches } from '@/app/auth/communitySecurityCrypto';
import type { CommunityProvider } from '@kissopen/kissopen-wire';
import type { Fastify } from '../types';

const random = () => randomBytes(32).toString('base64url');
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const sameHash = (text: string, expected: string) => timingSafeEqual(Buffer.from(hash(text)), Buffer.from(expected));
const idParams = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{43}$/) });
const providerParams = z.object({ provider: CommunityProviderSchema });
const secretString = z.string().regex(/^[a-zA-Z0-9_-]{43}$/);
const profile = (identity: { id: string; provider: string; name: string; username?: string | null }) => ({
    id: identity.id, provider: CommunityProviderSchema.parse(identity.provider), name: identity.name, username: identity.username ?? null,
});
const bearer = (header?: string) => header?.match(/^Bearer ([a-zA-Z0-9_-]{43})$/)?.[1];
const LOGIN_TTL = 10 * 60 * 1000;
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
const errorResponse = z.object({ error: z.string() });

/** Community identity is separate from the relay's encryption-key authentication. */
export function communityAuthRoutes(app: Fastify) {
    // No request logging on these routes: callback URLs contain provider codes.
    const options = { logLevel: 'silent' as const, bodyLimit: 16 * 1024 };
    const starts = new Map<string, { at: number; count: number }>();
    app.get('/v1/community/auth/providers', { ...options, schema: { response: { 200: CommunityProvidersSchema } } },
        async () => ({ providers: CommunityProviderSchema.options.filter(p => communityProviderConfig(p)) }));

    app.post('/v1/community/auth/start', { ...options, schema: {
        body: CommunityStartRequestSchema, response: { 200: CommunityStartResponseSchema, 503: errorResponse, 429: errorResponse },
    } }, async (request, reply) => {
        const config = communityProviderConfig(request.body.provider);
        if (!config) return reply.code(503).send({ error: '登录服务尚未配置，请使用本地工作区或联系管理员。' });
        const now = Date.now();
        for (const [ip, bucket] of starts) if (now - bucket.at > 60000) starts.delete(ip);
        const bucket = starts.get(request.ip) ?? { at: now, count: 0 };
        if (++bucket.count > 10 || starts.size > 10000) return reply.code(429).send({ error: '登录尝试过于频繁，请稍后再试。' });
        starts.set(request.ip, bucket);
        // Bounded durable state, shared across server instances and restarts.
        await db.communityOAuthLogin.deleteMany({ where: { expiresAt: { lte: new Date(now) } } });
        await db.communityAccountSession.deleteMany({ where: { expiresAt: { lte: new Date(now) } } });
        return communityOAuthStart(request.body.provider);
    });

    app.post('/v1/community/auth/password', { ...options, schema: { body: CommunityPasswordRequestSchema, response: { 200: CommunityLoginHandleSchema } } }, async request => {
        await throttle(`password-ip:${request.ip}`, 30);
        await throttle(`password-user:${request.body.username}`, 10);
        await db.communityOAuthLogin.deleteMany({ where: { expiresAt: { lte: new Date() } } });
        await db.communityAccountSession.deleteMany({ where: { expiresAt: { lte: new Date() } } });
        const identity = await db.communityIdentity.findUnique({ where: { username: request.body.username } });
        if (!await passwordMatches(request.body.password, identity?.passwordHash ?? null) || !identity) throw new SecurityProblem(400, 'Username or password is incorrect. / 用户名或密码不正确。');
        const id = random(), pollToken = random(), expiresAt = new Date(Date.now() + LOGIN_TTL);
        await db.communityOAuthLogin.create({ data: { id, provider: 'password', stateHash: hash(random()), pollTokenHash: hash(pollToken), browserProofHash: hash(random()),
            challenge: random(), identityId: identity.id, credentialVersion: identity.credentialVersion,
            status: identity.totpSecret ? 'second_factor' : 'authorized', expiresAt } });
        return { id, pollToken, expiresAt: expiresAt.toISOString() };
    });

    app.post('/v1/community/auth/:id/factor', { ...options, schema: { params: idParams, body: CommunityFactorRequestSchema } }, async request => {
        const login = await loginRead(request.params.id, request.headers.authorization);
        if (!login?.identity || login.status !== 'second_factor') throw new SecurityProblem(401, 'Sign-in expired. Please start again.');
        await throttle(`factor-ip:${request.ip}`, 40); await throttle(`factor:${login.identityId}`, 20);
        await db.$transaction(async tx => {
            const identity = await lockedIdentity(tx, login.identity!.id);
            if (identity.credentialVersion !== login.credentialVersion) throw new SecurityProblem(401, 'Sign-in state changed. Please start again.');
            await factorConsume(tx, identity, request.body.code);
            const consumed = await tx.communityOAuthLogin.updateMany({ where: { id: login.id, status: 'second_factor', expiresAt: { gt: new Date() } }, data: { status: 'authorized' } });
            if (consumed.count !== 1) throw new SecurityProblem(401, 'Sign-in expired. Please start again.');
        }); return { success: true };
    });

    app.get('/v1/community/auth/:id/authorize', { ...options, schema: {
        params: idParams, querystring: z.object({ proof: secretString, state: secretString }),
    } }, async (request, reply) => {
        const login = await db.communityOAuthLogin.findUnique({ where: { id: request.params.id } });
        if (!login || login.status !== 'pending' || login.expiresAt.getTime() <= Date.now() ||
            !sameHash(request.query.proof, login.browserProofHash) || !sameHash(request.query.state, login.stateHash))
            return reply.code(400).send({ error: '登录链接已失效，请重新发起登录。' });
        const config = communityProviderConfig(CommunityProviderSchema.parse(login.provider));
        if (!config) return reply.code(503).send({ error: '登录服务暂不可用。' });
        const cookie = random();
        const claimed = await db.communityOAuthLogin.updateMany({ where: { id: login.id,
            browserCookieHash: null, status: 'pending', expiresAt: { gt: new Date() } },
            data: { browserCookieHash: hash(cookie) } });
        if (claimed.count !== 1) return reply.code(400).send({ error: '登录链接已使用，请返回应用。' });
        reply.header('Set-Cookie', `ko_oauth_${login.id}=${cookie}; Path=/v1/community/auth; HttpOnly; SameSite=Lax; Max-Age=600${config.redirectUri.startsWith('https:') ? '; Secure' : ''}`);
        reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
        const target = new URL(config.authorize);
        target.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri,
            response_type: 'code', scope: config.scope, state: request.query.state }).toString();
        if (config.pkce) {
            target.searchParams.set('code_challenge', createHash('sha256').update(login.verifier!).digest('base64url'));
            target.searchParams.set('code_challenge_method', 'S256');
        }
        return reply.redirect(target.href);
    });

    app.get('/v1/community/auth/:provider/callback', { ...options, schema: {
        params: providerParams, querystring: z.object({ state: secretString, code: z.string().min(1).max(4096).optional(),
            error: z.string().max(200).optional(), error_description: z.string().max(2000).optional() }),
    } }, async (request, reply) => {
        reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer')
            .header('Content-Security-Policy', communityAuthPageCsp)
            .header('X-Content-Type-Options', 'nosniff').type('text/html; charset=utf-8');
        const login = await db.communityOAuthLogin.findUnique({ where: { stateHash: hash(request.query.state) } });
        const cookie = login ? request.headers.cookie?.split(';').map(p => p.trim()).find(p => p.startsWith(`ko_oauth_${login.id}=`))?.split('=')[1] : undefined;
        if (!login || login.provider !== request.params.provider || login.status !== 'pending' ||
            login.expiresAt.getTime() <= Date.now() || !cookie || !login.browserCookieHash || !sameHash(cookie, login.browserCookieHash))
            return reply.code(400).send(communityAuthCompletionPage('expired'));
        const claimed = await db.communityOAuthLogin.updateMany({ where: { id: login.id, status: 'pending',
            expiresAt: { gt: new Date() } }, data: { status: 'processing', verifier: null, browserCookieHash: null } });
        if (claimed.count !== 1) return reply.code(400).send(communityAuthCompletionPage('expired'));
        reply.header('Set-Cookie', `ko_oauth_${login.id}=; Path=/v1/community/auth; HttpOnly; SameSite=Lax; Max-Age=0${communityPublicOrigin()?.startsWith('https:') ? '; Secure' : ''}`);
        try {
            if (request.query.error || !request.query.code) throw new Error('Authorization cancelled');
            const provider = request.params.provider;
            const result = await communityProviderIdentity(provider, request.query.code, login.verifier);
            await db.$transaction(async tx => {
                const binding = await tx.communityOAuthBinding.findUnique({ where: { provider_subject: { provider, subject: result.subject } } });
                let identity;
                if (login.intent !== 'signin') {
                    if (!login.targetIdentityId || !login.sessionHash) throw new Error('Missing target');
                    identity = await lockedIdentity(tx, login.targetIdentityId);
                    const session = await tx.communityAccountSession.findUnique({ where: { tokenHash: login.sessionHash } });
                    if (!session || session.expiresAt.getTime() <= Date.now() || identity.credentialVersion !== login.credentialVersion) throw new Error('Target session expired');
                    if (login.intent === 'reauthenticate') {
                        if (binding?.identityId !== identity.id) throw new SecurityProblem(409, 'Choose the provider account already linked to this KissOpen account. / 请使用已绑定的第三方账号验证。');
                    } else {
                        if (binding && binding.identityId !== identity.id) throw new SecurityProblem(409, 'This provider account is already linked to another KissOpen account. Accounts were not merged. / 此第三方账号已绑定其他账号，不会自动合并。');
                        if (identity.bindings.some(b => b.provider === provider && b.subject !== result.subject)) throw new SecurityProblem(409, 'Unlink the existing account for this provider before linking another one. / 请先解绑该服务商的旧账号。');
                        if (!binding) await tx.communityOAuthBinding.create({ data: { provider, subject: result.subject, identityId: identity.id } });
                    }
                } else if (binding) {
                    identity = await lockedIdentity(tx, binding.identityId);
                    // Recheck the authoritative binding under the identity lock.
                    const currentBinding = await tx.communityOAuthBinding.findUnique({ where: { provider_subject: { provider, subject: result.subject } } });
                    if (currentBinding?.identityId !== identity.id) throw new Error('Provider binding changed');
                } else {
                    const created = await tx.communityIdentity.create({ data: { provider, ...result, bindings: { create: { provider, subject: result.subject } } } });
                    identity = await lockedIdentity(tx, created.id);
                }
                const updated = await tx.communityOAuthLogin.updateMany({ where: { id: login.id, status: 'processing', expiresAt: { gt: new Date() } },
                    data: { status: login.intent === 'link' ? 'linked' : identity.totpSecret ? 'second_factor' : 'authorized', identityId: identity.id, credentialVersion: identity.credentialVersion } });
                if (updated.count !== 1) throw new Error('Login expired');
            });
            return reply.send(communityAuthCompletionPage('success'));
        } catch (error) {
            await db.communityOAuthLogin.updateMany({ where: { id: login.id, status: 'processing' }, data: { status: 'failed', errorMessage: error instanceof SecurityProblem ? error.message : null } });
            return reply.send(communityAuthCompletionPage('failed'));
        }
    });

    app.get('/v1/community/auth/:id/status', { ...options, schema: { params: idParams,
        response: { 200: CommunityStatusSchema, 401: errorResponse } } }, async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        const login = await loginRead(request.params.id, request.headers.authorization);
        if (!login) return reply.code(401).send({ error: '登录已过期，请重新登录。' });
        if (login.status === 'failed') return { status: 'failed' as const, message: login.errorMessage ?? '授权未完成。请重新登录，或选择其他登录方式。' };
        if (login.status === 'second_factor') return { status: 'second_factor' as const };
        if (login.status === 'linked') return { status: 'linked' as const };
        if (login.status !== 'authorized' || !login.identity) return { status: 'pending' as const };
        return { status: 'authorized' as const, profile: profile(login.identity), challenge: login.challenge,
            workspacePublicKey: login.identity.account?.publicKey ?? null };
    });

    app.delete('/v1/community/auth/:id', { ...options, schema: { params: idParams } }, async (request, reply) => {
        const login = await loginRead(request.params.id, request.headers.authorization);
        if (!login) return reply.code(401).send({ error: '登录已过期。' });
        await db.communityOAuthLogin.deleteMany({ where: { id: login.id } });
        return { success: true };
    });

    app.post('/v1/community/auth/:id/complete', { ...options, schema: { params: idParams,
        body: CommunityCompleteRequestSchema, response: { 200: CommunityCompleteResponseSchema, 401: errorResponse, 409: errorResponse } } }, async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        const login = await loginRead(request.params.id, request.headers.authorization);
        if (!login || login.intent !== 'signin' || login.status !== 'authorized' || !login.identity) return reply.code(401).send({ error: '登录已失效，请重试。' });
        const input = request.body;
        if (input.mode === 'workspace') {
            const key = Buffer.from(input.publicKey, 'base64');
            const signature = Buffer.from(input.signature, 'base64');
            if (key.length !== 32 || signature.length !== 64 || !nacl.sign.detached.verify(Buffer.from(login.challenge, 'base64url'), signature, key))
                return reply.code(401).send({ error: '工作区密钥验证失败。' });
            if (login.identity.account && login.identity.account.publicKey !== key.toString('hex'))
                return reply.code(409).send({ error: '请恢复已有工作区密钥，不会为已有账号创建空的新历史。' });
        }
        const token = random();
        try {
            const accountId = await db.$transaction(async tx => {
                const consumed = await tx.communityOAuthLogin.updateMany({ where: { id: login.id, status: 'authorized',
                    expiresAt: { gt: new Date() } }, data: { status: 'complete' } });
                if (consumed.count !== 1) throw new Error('Consumed login');
                // Lock the identity before its first workspace is bound. Parallel
                // first logins must not race to assign different encryption keys.
                await tx.$queryRaw`SELECT "id" FROM "CommunityIdentity" WHERE "id" = ${login.identity!.id} FOR UPDATE`;
                const identity = await tx.communityIdentity.findUniqueOrThrow({ where: { id: login.identity!.id }, include: { account: true } });
                if (identity.credentialVersion !== login.credentialVersion) throw new Error('Credentials changed');
                let accountId = identity.accountId;
                if (input.mode === 'workspace') {
                    const publicKey = Buffer.from(input.publicKey, 'base64').toString('hex');
                    if (identity.account && identity.account.publicKey !== publicKey) throw new Error('Workspace key changed');
                    if (!accountId) {
                        const account = await tx.account.upsert({ where: { publicKey }, update: {}, create: { publicKey } });
                        accountId = account.id;
                        await tx.communityIdentity.update({ where: { id: identity.id }, data: { accountId } });
                    }
                }
                await tx.communityAccountSession.create({ data: { tokenHash: hash(token), identityId: identity.id,
                    method: login.provider === 'password' ? 'password' : 'oauth',
                    expiresAt: new Date(Date.now() + SESSION_TTL) } });
                return accountId;
            });
            return { profile: profile(login.identity), token,
                ...(input.mode === 'workspace' && accountId ? { workspaceToken: await auth.createToken(accountId) } : {}) };
        } catch {
            return reply.code(409).send({ error: '登录状态已变化，请重新登录。已有工作区不会被覆盖。' });
        }
    });

    app.get('/v1/community/account', { ...options, schema: { response: { 200: CommunityProfileSchema, 401: errorResponse } } }, async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        const token = bearer(request.headers.authorization);
        const session = token ? await db.communityAccountSession.findUnique({ where: { tokenHash: hash(token) }, include: { identity: true } }) : null;
        if (!session || session.expiresAt.getTime() <= Date.now()) return reply.code(401).send({ error: '请重新登录。' });
        return profile(session.identity);
    });
    app.delete('/v1/community/account/session', options, async (request, reply) => {
        const token = bearer(request.headers.authorization);
        if (!token) return reply.code(401).send({ error: '请重新登录。' });
        await db.$transaction(async tx => {
            const session = await tx.communityAccountSession.findUnique({ where: { tokenHash: hash(token) } });
            if (session) await lockedIdentity(tx, session.identityId);
            await tx.communitySecurityProof.deleteMany({ where: { sessionHash: hash(token) } });
            await tx.communityOAuthLogin.deleteMany({ where: { sessionHash: hash(token) } });
            await tx.communityWorkspaceTransfer.deleteMany({ where: { sessionHash: hash(token) } });
            await tx.communityAccountSession.deleteMany({ where: { tokenHash: hash(token) } });
        });
        return { success: true };
    });
}

async function loginRead(id: string, header?: string) {
    const token = bearer(header);
    if (!token) return null;
    const login = await db.communityOAuthLogin.findUnique({ where: { id }, include: { identity: { include: { account: true } } } });
    return login && login.status !== 'complete' && login.expiresAt.getTime() > Date.now() && sameHash(token, login.pollTokenHash) ? login : null;
}

export async function communityOAuthStart(provider: CommunityProvider, target?: { intent: string; targetIdentityId: string; sessionHash: string; credentialVersion: number }) {
    const config = communityProviderConfig(provider);
    if (!config) throw new SecurityProblem(503, 'This sign-in provider is not configured. / 此登录方式尚未配置。');
    const id = random(), state = random(), pollToken = random(), browserProof = random();
    const expiresAt = new Date(Date.now() + LOGIN_TTL);
    await db.communityOAuthLogin.create({ data: { id, provider, stateHash: hash(state), pollTokenHash: hash(pollToken), browserProofHash: hash(browserProof),
        verifier: config.pkce ? random() : null, challenge: random(), expiresAt, ...target } });
    const url = new URL(`${communityPublicOrigin()}/v1/community/auth/${id}/authorize`);
    url.searchParams.set('proof', browserProof); url.searchParams.set('state', state);
    return { id, pollToken, authorizationUrl: url.href, expiresAt: expiresAt.toISOString() };
}
