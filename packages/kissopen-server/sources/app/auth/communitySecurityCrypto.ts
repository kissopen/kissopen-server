import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';

export const securityHash = (value: string) => createHash('sha256').update(value).digest('hex');
export const securityToken = () => randomBytes(32).toString('base64url');
let activeHashes = 0;
const derive = (password: string, salt: Buffer): Promise<Buffer> => new Promise((resolve, reject) => {
    // Each job uses ~128 MiB; reject overload instead of building an unbounded queue.
    if (activeHashes >= 2) { reject(new Error('Password service is busy. Please try again shortly.')); return; }
    ++activeHashes;
    scrypt(password, salt, 32, { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 }, (error, value) => {
        --activeHashes;
        if (error) reject(error); else resolve(value);
    });
});
export async function passwordHash(password: string) {
    const salt = randomBytes(16);
    return `scrypt:131072:8:1:${salt.toString('hex')}:${(await derive(password, salt)).toString('hex')}`;
}
export async function passwordMatches(password: string, encoded: string | null) {
    const parts = encoded?.split(':');
    const valid = parts?.length === 6 && parts.slice(0, 4).join(':') === 'scrypt:131072:8:1'
        && /^[a-f0-9]{32}$/.test(parts[4]) && /^[a-f0-9]{64}$/.test(parts[5]);
    // Unknown usernames take the same expensive path and return the same error.
    const actual = await derive(password, Buffer.from(valid ? parts![4] : '0'.repeat(32), 'hex'));
    const expected = Buffer.from(valid ? parts![5] : '0'.repeat(64), 'hex');
    return timingSafeEqual(actual, expected) && !!valid;
}
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(bytes: Buffer) {
    let bits = 0, value = 0, output = '';
    for (const byte of bytes) { value = (value << 8) | byte; bits += 8;
        while (bits >= 5) { bits -= 5; output += alphabet[(value >>> bits) & 31]; }
    }
    if (bits) output += alphabet[(value << (5 - bits)) & 31];
    return output;
}
function decode32(text: string) {
    let bits = 0, value = 0; const bytes: number[] = [];
    for (const char of text) { const index = alphabet.indexOf(char); if (index < 0) throw new Error('Invalid authenticator secret');
        value = (value << 5) | index; bits += 5;
        if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 255); }
    }
    return Buffer.from(bytes);
}
export function totpCode(secret: string, step: number) {
    const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(step));
    const digest = createHmac('sha1', decode32(secret)).update(counter).digest();
    return ((digest.readUInt32BE(digest[19] & 15) & 0x7fffffff) % 1000000).toString().padStart(6, '0');
}
export function totpStep(secret: string, code: string, at = Date.now()) {
    if (!/^\d{6}$/.test(code)) return null;
    const now = Math.floor(at / 30000);
    for (const step of [now, now - 1, now + 1])
        if (timingSafeEqual(Buffer.from(totpCode(secret, step)), Buffer.from(code))) return step;
    return null;
}
function encryptionKey() {
    const master = process.env.HANDY_MASTER_SECRET;
    if (!master || master.length < 32) throw new Error('Configure a persistent relay master secret before enabling two-factor authentication.');
    return createHash('sha256').update('kissopen-account-totp-v1\0').update(master).digest();
}
export function sealSecret(secret: string, identityId: string) {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
    cipher.setAAD(Buffer.from(identityId));
    const payload = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), payload]).toString('base64url');
}
export function openSecret(sealed: string, identityId: string) {
    const data = Buffer.from(sealed, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), data.subarray(0, 12));
    decipher.setAAD(Buffer.from(identityId)); decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
}
export function recoveryCodes(identityId: string) {
    const codes = Array.from({ length: 10 }, () => randomBytes(10).toString('hex'));
    return { codes, hashes: JSON.stringify(codes.map(code => recoveryHash(identityId, code))) };
}
export function recoveryHash(identityId: string, code: string) {
    return securityHash(`recovery\0${identityId}\0${code.trim().toLowerCase().replace(/[- ]/g, '')}`);
}
