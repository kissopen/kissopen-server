import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
    CommunitySecuritySchema, CommunityVerifyRequestSchema, CommunityProofSchema,
    CommunityUsernameRequestSchema, CommunityPasswordChangeSchema, CommunityTotpSetupSchema,
    CommunityTotpConfirmSchema, CommunityRecoverySchema, CommunityOAuthManageSchema,
    CommunityOAuthCompleteSchema, CommunityOAuthUnlinkSchema, CommunityStartResponseSchema,
    CommunityProviderSchema,
    CommunityProfileUsernameRequestSchema,
} from '@kissopen/kissopen-wire';
import { db } from '@/storage/db';
import { communityProviderConfig } from '@/app/auth/communityProviders';
import { securitySession, throttle, SecurityProblem, lockedIdentity, factorConsume, proofIssue, proofConsume, credentialRevoke } from '@/app/auth/communitySecurity';
import { securityHash, securityToken, passwordMatches, passwordHash, base32, sealSecret, openSecret, totpStep, recoveryCodes } from '@/app/auth/communitySecurityCrypto';
import type { Fastify } from '../types';
import { communityOAuthStart } from './communityAuthRoutes';

export function communitySecurityRoutes(app: Fastify) {
    const options = { logLevel: 'silent' as const, bodyLimit: 16 * 1024 };
    // Keep authentication errors friendly, never expose database/crypto contents.
    app.setErrorHandler((error, _request, reply) => {
        if (error instanceof SecurityProblem) {
            if (error.status === 429) reply.header('Retry-After', '900');
            return reply.code(error.status).send({ error: error.message });
        }
        if (typeof error === 'object' && error && ('validation' in error || ('code' in error && error.code === 'FST_ERR_VALIDATION'))) return reply.code(400).send({ error: 'Check the fields and try again. / 请检查输入内容。' });
        return reply.code(503).send({ error: 'Security service is temporarily unavailable. Please try again shortly. / 安全服务暂不可用，请稍后重试。' });
    });
    app.get('/v1/community/security', { ...options, schema: { response: { 200: CommunitySecuritySchema } } }, async request => {
        const { identity } = await securitySession(request.headers.authorization);
        const bindings = await db.communityOAuthBinding.findMany({ where: { identityId: identity.id } });
        return { username: identity.username, passwordEnabled: !!identity.passwordHash, totpEnabled: !!identity.totpSecret,
            recoveryCodesRemaining: JSON.parse(identity.recoveryHashes).length,
            providers: CommunityProviderSchema.options.map(provider => ({ provider, configured: !!communityProviderConfig(provider), linked: bindings.some(b => b.provider === provider) })) };
    });
    // Usernames are profile data. The authenticated session, not a separate
    // security proof, owns this edit; the relay remains the unique login-name authority.
    app.post('/v1/community/profile/username', { ...options, schema: { body: CommunityProfileUsernameRequestSchema } }, async request => {
        const session = await securitySession(request.headers.authorization);
        await throttle(`profile-username:${session.identityId}`, 30);
        try {
            await db.$transaction(async tx => {
                const identity = await lockedIdentity(tx, session.identityId);
                const active = await tx.communityAccountSession.findUnique({ where: { tokenHash: session.tokenHash } });
                if (!active || active.expiresAt.getTime() <= Date.now()) throw new SecurityProblem(401, 'Please sign in again.');
                if (request.body.username === null && identity.passwordHash) throw new SecurityProblem(400, 'A username is required while password sign-in is enabled.');
                await tx.communityIdentity.update({ where: { id: identity.id }, data: { username: request.body.username } });
            });
        } catch (error) {
            if (error instanceof SecurityProblem) throw error;
            if (typeof error === 'object' && error && 'code' in error && error.code === 'P2002') throw new SecurityProblem(409, 'This username is already taken. / 用户名已被使用。');
            throw error;
        }
        return { success: true };
    });
    app.post('/v1/community/security/verify', { ...options, schema: { body: CommunityVerifyRequestSchema, response: { 200: CommunityProofSchema } } }, async request => {
        const session = await securitySession(request.headers.authorization);
        await throttle(`verify:${session.identityId}`, 10);
        const old = session.identity;
        if (old.passwordHash) {
            if (!await passwordMatches(request.body.password ?? '', old.passwordHash)) throw new SecurityProblem(400, 'Current password is incorrect. / 当前密码不正确。');
        } else if (session.method !== 'oauth' || session.createdAt.getTime() < Date.now() - 10 * 60000) {
            throw new SecurityProblem(403, 'Reauthenticate with a linked provider to continue. / 请通过已绑定的第三方账号重新验证。');
        }
        return db.$transaction(async tx => {
            const identity = await lockedIdentity(tx, session.identityId);
            if (identity.credentialVersion !== old.credentialVersion || !await tx.communityAccountSession.findUnique({ where: { tokenHash: session.tokenHash } })) throw new SecurityProblem(401, 'Sign-in state changed. Please try again.');
            await factorConsume(tx, identity, request.body.code);
            return proofIssue(tx, session.tokenHash);
        });
    });
    app.post('/v1/community/security/username', { ...options, schema: { body: CommunityUsernameRequestSchema } }, async request => {
        const session = await securitySession(request.headers.authorization);
        try {
            await db.$transaction(async tx => {
                await lockedIdentity(tx, session.identityId); await proofConsume(tx, session, request.body.proof);
                await tx.communityIdentity.update({ where: { id: session.identityId }, data: { username: request.body.username } });
            });
        } catch (error) {
            if (error instanceof SecurityProblem) throw error;
            if (typeof error === 'object' && error && 'code' in error && error.code === 'P2002') throw new SecurityProblem(409, 'This username is already taken. / 用户名已被使用。');
            throw error;
        }
        return { success: true };
    });
    app.post('/v1/community/security/password', { ...options, schema: { body: CommunityPasswordChangeSchema } }, async request => {
        const session = await securitySession(request.headers.authorization);
        await throttle(`password-change:${session.identityId}`, 10);
        // Validate proof before expensive hashing; consume it only in the mutation.
        if (!await db.communitySecurityProof.findFirst({ where: { tokenHash: securityHash(request.body.proof), sessionHash: session.tokenHash, expiresAt: { gt: new Date() } } })) throw new SecurityProblem(403, 'Verify your identity first.');
        const encoded = await passwordHash(request.body.password);
        await db.$transaction(async tx => {
            const identity = await lockedIdentity(tx, session.identityId); await proofConsume(tx, session, request.body.proof);
            if (!identity.username) throw new SecurityProblem(400, 'Set your username first. / 请先设置用户名。');
            await tx.communityIdentity.update({ where: { id: identity.id }, data: { passwordHash: encoded } });
            await credentialRevoke(tx, identity.id, session.tokenHash);
        });
        return { success: true };
    });
    app.post('/v1/community/security/totp/begin', { ...options, schema: { body: CommunityProofSchema, response: { 200: CommunityTotpSetupSchema } } }, async request => {
        const session = await securitySession(request.headers.authorization);
        const secret = base32(randomBytes(20)), setupToken = securityToken();
        await db.$transaction(async tx => {
            const identity = await lockedIdentity(tx, session.identityId); await proofConsume(tx, session, request.body.proof);
            if (identity.totpSecret) throw new SecurityProblem(409, 'Two-factor authentication is already enabled.');
            await tx.communityIdentity.update({ where: { id: identity.id }, data: { totpPending: sealSecret(secret, identity.id),
                totpSetupHash: securityHash(setupToken), totpSetupSession: session.tokenHash, totpSetupExpires: new Date(Date.now() + 10 * 60000) } });
        });
        return { setupToken, secret, uri: `otpauth://totp/${encodeURIComponent(`KissOpen:${session.identity.username ?? session.identity.name}`)}?secret=${secret}&issuer=KissOpen&algorithm=SHA1&digits=6&period=30` };
    });
    app.post('/v1/community/security/totp/confirm', { ...options, schema: { body: CommunityTotpConfirmSchema, response: { 200: CommunityRecoverySchema } } }, async request => {
        const session = await securitySession(request.headers.authorization);
        await throttle(`factor:${session.identityId}`, 20);
        return db.$transaction(async tx => {
            const identity = await lockedIdentity(tx, session.identityId);
            if (!await tx.communityAccountSession.findUnique({ where: { tokenHash: session.tokenHash } })) throw new SecurityProblem(401, 'Please sign in again.');
            if (identity.totpSecret || !identity.totpPending || identity.totpSetupHash !== securityHash(request.body.setupToken) || identity.totpSetupSession !== session.tokenHash || !identity.totpSetupExpires || identity.totpSetupExpires.getTime() <= Date.now()) throw new SecurityProblem(400, 'Authenticator setup expired. Please start again. / 设置已过期，请重新开始。');
            const step = totpStep(openSecret(identity.totpPending, identity.id), request.body.code);
            if (step === null) throw new SecurityProblem(400, 'Authenticator code is incorrect. / 验证码不正确。');
            const recovery = recoveryCodes(identity.id);
            await tx.communityIdentity.update({ where: { id: identity.id }, data: { totpSecret: identity.totpPending, totpLastStep: BigInt(step),
                recoveryHashes: recovery.hashes, totpPending: null, totpSetupHash: null, totpSetupSession: null, totpSetupExpires: null } });
            await credentialRevoke(tx, identity.id, session.tokenHash);
            return { codes: recovery.codes };
        });
    });
    app.post('/v1/community/security/totp/disable', { ...options, schema: { body: CommunityProofSchema } }, async request => {
        const session = await securitySession(request.headers.authorization);
        await db.$transaction(async tx => {
            await lockedIdentity(tx, session.identityId); await proofConsume(tx, session, request.body.proof);
            await tx.communityIdentity.update({ where: { id: session.identityId }, data: { totpSecret: null, totpLastStep: -1n, recoveryHashes: '[]', totpPending: null, totpSetupHash: null, totpSetupSession: null, totpSetupExpires: null } });
            await credentialRevoke(tx, session.identityId, session.tokenHash);
        }); return { success: true };
    });
    app.post('/v1/community/security/recovery', { ...options, schema: { body: CommunityProofSchema, response: { 200: CommunityRecoverySchema } } }, async request => {
        const session = await securitySession(request.headers.authorization);
        return db.$transaction(async tx => {
            const identity = await lockedIdentity(tx, session.identityId); await proofConsume(tx, session, request.body.proof);
            if (!identity.totpSecret) throw new SecurityProblem(400, 'Enable two-factor authentication first.');
            const recovery = recoveryCodes(identity.id);
            await tx.communityIdentity.update({ where: { id: identity.id }, data: { recoveryHashes: recovery.hashes } });
            return { codes: recovery.codes };
        });
    });
    app.post('/v1/community/security/oauth/start', { ...options, schema: { body: CommunityOAuthManageSchema, response: { 200: CommunityStartResponseSchema } } }, async request => {
        const session = await securitySession(request.headers.authorization);
        await throttle(`oauth-manage:${session.identityId}`, 20);
        await db.$transaction(async tx => {
            const identity = await lockedIdentity(tx, session.identityId);
            if (request.body.intent === 'link') await proofConsume(tx, session, request.body.proof);
            else if (!identity.bindings.some(b => b.provider === request.body.provider)) throw new SecurityProblem(400, 'Choose a linked provider.');
        });
        return communityOAuthStart(request.body.provider, { intent: request.body.intent, targetIdentityId: session.identityId, sessionHash: session.tokenHash, credentialVersion: session.identity.credentialVersion });
    });
    app.post('/v1/community/security/oauth/complete', { ...options, schema: { body: CommunityOAuthCompleteSchema, response: { 200: CommunityProofSchema } } }, async request => {
        const session = await securitySession(request.headers.authorization);
        return db.$transaction(async tx => {
            const identity = await lockedIdentity(tx, session.identityId);
            const login = await tx.communityOAuthLogin.findUnique({ where: { id: request.body.id } });
            if (!login || login.intent !== 'reauthenticate' || login.status !== 'authorized' || login.targetIdentityId !== identity.id || login.sessionHash !== session.tokenHash || login.pollTokenHash !== securityHash(request.body.pollToken) || login.credentialVersion !== identity.credentialVersion || login.expiresAt.getTime() <= Date.now()) throw new SecurityProblem(403, 'Reauthentication expired. Please start again.');
            const consumed = await tx.communityOAuthLogin.updateMany({ where: { id: login.id, status: 'authorized' }, data: { status: 'complete' } });
            if (consumed.count !== 1) throw new SecurityProblem(403, 'Reauthentication already used.');
            if (!await tx.communityAccountSession.findUnique({ where: { tokenHash: session.tokenHash } })) throw new SecurityProblem(401, 'Please sign in again.');
            return proofIssue(tx, session.tokenHash);
        });
    });
    app.post('/v1/community/security/oauth/unlink', { ...options, schema: { body: CommunityOAuthUnlinkSchema } }, async request => {
        const session = await securitySession(request.headers.authorization);
        await db.$transaction(async tx => {
            const identity = await lockedIdentity(tx, session.identityId); await proofConsume(tx, session, request.body.proof);
            if (!identity.bindings.some(b => b.provider === request.body.provider)) throw new SecurityProblem(400, 'That provider is not linked.');
            const remainingProvider = identity.bindings.some(binding => binding.provider !== request.body.provider && !!communityProviderConfig(CommunityProviderSchema.parse(binding.provider)));
            if (!remainingProvider && !(identity.passwordHash && identity.username)) throw new SecurityProblem(409, 'Keep at least one available sign-in method. Set a password or link another configured provider first. / 不能移除最后一种可用的登录方式。');
            await tx.communityOAuthBinding.deleteMany({ where: { identityId: identity.id, provider: request.body.provider } });
            await credentialRevoke(tx, identity.id, session.tokenHash);
        }); return { success: true };
    });
}
