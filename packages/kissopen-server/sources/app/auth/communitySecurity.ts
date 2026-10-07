import { Prisma } from '@prisma/client';
import { db } from '@/storage/db';
import { openSecret, recoveryHash, securityHash, securityToken, totpStep } from './communitySecurityCrypto';

export class SecurityProblem extends Error {
    readonly statusCode: number;
    constructor(readonly status: number, message: string) { super(message); this.statusCode = status; }
}
export const securityBearer = (header?: string) => header?.match(/^Bearer ([a-zA-Z0-9_-]{43})$/)?.[1];
export async function securitySession(header?: string) {
    const token = securityBearer(header);
    const session = token ? await db.communityAccountSession.findUnique({ where: { tokenHash: securityHash(token) }, include: { identity: true } }) : null;
    if (!session || session.expiresAt.getTime() <= Date.now()) throw new SecurityProblem(401, 'Please sign in again. / 请重新登录。');
    return session;
}
export type SecuritySession = Awaited<ReturnType<typeof securitySession>>;
export async function throttle(key: string, limit = 10) {
    const hashed = securityHash(key);
    await db.communityAuthThrottle.deleteMany({ where: { expiresAt: { lte: new Date() } } });
    if (await db.communityAuthThrottle.count() >= 10000) throw new SecurityProblem(429, 'Too many attempts. Please try again in 15 minutes. / 请在 15 分钟后重试。');
    const entry = await db.communityAuthThrottle.upsert({ where: { key: hashed },
        create: { key: hashed, count: 1, expiresAt: new Date(Date.now() + 15 * 60000) }, update: { count: { increment: 1 } } });
    if (entry.count > limit) throw new SecurityProblem(429, 'Too many attempts. Please try again in 15 minutes. / 请在 15 分钟后重试。');
}
export async function lockedIdentity(tx: Prisma.TransactionClient, id: string) {
    await tx.$queryRaw`SELECT "id" FROM "CommunityIdentity" WHERE "id" = ${id} FOR UPDATE`;
    return tx.communityIdentity.findUniqueOrThrow({ where: { id }, include: { bindings: true } });
}
/** Caller holds the identity lock, making timestep/code consumption atomic. */
export async function factorConsume(tx: Prisma.TransactionClient, identity: Awaited<ReturnType<typeof lockedIdentity>>, code?: string) {
    if (!identity.totpSecret) return;
    const message = 'Enter a fresh authenticator code or an unused recovery code. / 请输入新的验证码或未使用的恢复码。';
    if (!code) throw new SecurityProblem(400, message);
    const step = totpStep(openSecret(identity.totpSecret, identity.id), code.trim());
    if (step !== null && BigInt(step) > identity.totpLastStep) {
        await tx.communityIdentity.update({ where: { id: identity.id }, data: { totpLastStep: BigInt(step) } }); return;
    }
    const hashes: string[] = JSON.parse(identity.recoveryHashes);
    const hash = recoveryHash(identity.id, code);
    if (!hashes.includes(hash)) throw new SecurityProblem(400, message);
    await tx.communityIdentity.update({ where: { id: identity.id }, data: { recoveryHashes: JSON.stringify(hashes.filter(value => value !== hash)) } });
}
export async function proofIssue(tx: Prisma.TransactionClient, sessionHash: string) {
    const proof = securityToken();
    await tx.communitySecurityProof.deleteMany({ where: { expiresAt: { lte: new Date() } } });
    await tx.communitySecurityProof.create({ data: { tokenHash: securityHash(proof), sessionHash, expiresAt: new Date(Date.now() + 5 * 60000) } });
    return { proof };
}
export async function proofConsume(tx: Prisma.TransactionClient, session: SecuritySession, proof: string) {
    // Session is checked again inside the mutation transaction; an earlier read
    // must not permit a request to survive concurrent sign-out/password change.
    const current = await tx.communityAccountSession.findUnique({ where: { tokenHash: session.tokenHash } });
    if (!current || current.expiresAt.getTime() <= Date.now()) throw new SecurityProblem(401, 'Please sign in again.');
    const result = await tx.communitySecurityProof.deleteMany({ where: {
        tokenHash: securityHash(proof), sessionHash: session.tokenHash, expiresAt: { gt: new Date() },
    } });
    if (result.count !== 1) throw new SecurityProblem(403, 'Verify your identity again before making this change. / 请先重新验证身份。');
}
export async function credentialRevoke(tx: Prisma.TransactionClient, identityId: string, keepSession: string) {
    const sessions = await tx.communityAccountSession.findMany({ where: { identityId }, select: { tokenHash: true } });
    await tx.communitySecurityProof.deleteMany({ where: { sessionHash: { in: sessions.map(s => s.tokenHash) } } });
    await tx.communityAccountSession.deleteMany({ where: { identityId, tokenHash: { not: keepSession } } });
    await tx.communityOAuthLogin.deleteMany({ where: { OR: [{ identityId }, { targetIdentityId: identityId }] } });
    await tx.communityIdentity.update({ where: { id: identityId }, data: { credentialVersion: { increment: 1 } } });
}
