import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { SecurityProblem } from './communitySecurity';

function key() {
    const master = process.env.HANDY_MASTER_SECRET;
    if (!master || master.length < 32)
        throw new SecurityProblem(503, 'Workspace connection is not configured. Contact your server administrator. / 工作区连接未配置，请联系服务器管理员。');
    return createHash('sha256').update('kissopen-workspace-escrow-v1\0').update(master).digest();
}
const aad = (identityId: string, accountId: string, publicKey: string) =>
    Buffer.from(JSON.stringify(['kissopen-workspace-escrow-v1', identityId, accountId, publicKey]));

export function workspaceSeedSeal(seed: Uint8Array, identityId: string, accountId: string, publicKey: string) {
    if (seed.length !== 32) throw new Error('Invalid workspace seed');
    const encryptionKey = key();
    try {
        const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
        cipher.setAAD(aad(identityId, accountId, publicKey));
        const encrypted = Buffer.concat([cipher.update(seed), cipher.final()]);
        return 'v1:' + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
    } finally { encryptionKey.fill(0); }
}

export function workspaceSeedOpen(encrypted: string, identityId: string, accountId: string, publicKey: string) {
    const encryptionKey = key(); // Configuration errors remain actionable, not a new identity.
    try {
        if (!/^v1:[a-zA-Z0-9_-]{80}$/.test(encrypted)) throw new Error('Invalid escrow');
        const bytes = Buffer.from(encrypted.slice(3), 'base64url');
        const decipher = createDecipheriv('aes-256-gcm', encryptionKey, bytes.subarray(0, 12));
        decipher.setAAD(aad(identityId, accountId, publicKey));
        decipher.setAuthTag(bytes.subarray(12, 28));
        const seed = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
        if (seed.length !== 32) { seed.fill(0); throw new Error('Invalid seed'); }
        return seed;
    } catch {
        throw new SecurityProblem(503, 'Your workspace key could not be restored. Existing data was preserved; contact your administrator. / 无法恢复工作区密钥，已有数据已保留，请联系管理员。');
    } finally { encryptionKey.fill(0); }
}
