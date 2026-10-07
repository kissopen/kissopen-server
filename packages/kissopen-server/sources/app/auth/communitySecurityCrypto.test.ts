import { describe, it, expect, vi } from 'vitest';
import { passwordHash, passwordMatches, base32, totpCode, totpStep, sealSecret, openSecret, recoveryCodes, recoveryHash } from './communitySecurityCrypto';

describe('account security cryptography', () => {
    it('salts passwords, verifies correctly and rejects unknown/malformed hashes', async () => {
        const password = 'a-test-password-only';
        const first = await passwordHash(password), second = await passwordHash(password);
        expect(first).not.toBe(second); expect(first).not.toContain(password);
        expect(await passwordMatches(password, first)).toBe(true);
        expect(await passwordMatches('incorrect', first)).toBe(false);
        expect(await passwordMatches(password, null)).toBe(false);
        expect(await passwordMatches(password, 'bad-hash')).toBe(false);
    }, 15000);
    it('matches the RFC 6238 SHA1 vector and rejects out-of-window codes', () => {
        const secret = base32(Buffer.from('12345678901234567890'));
        expect(totpCode(secret, 1)).toBe('287082');
        expect(totpStep(secret, '287082', 59000)).toBe(1);
        expect(totpStep(secret, '287082', 150000)).toBe(null);
        expect(totpStep(secret, 'abc123', 59000)).toBe(null);
    });
    it('encrypts secrets with identity-bound authenticated encryption', () => {
        vi.stubEnv('HANDY_MASTER_SECRET', 'test-only-master-secret'.repeat(3));
        try {
            const sealed = sealSecret('TOPSECRET', 'account-a');
            expect(sealed).not.toContain('TOPSECRET');
            expect(openSecret(sealed, 'account-a')).toBe('TOPSECRET');
            expect(() => openSecret(sealed, 'account-b')).toThrow();
            vi.stubEnv('HANDY_MASTER_SECRET', 'another-test-secret'.repeat(3));
            expect(() => openSecret(sealed, 'account-a')).toThrow();
            vi.stubEnv('HANDY_MASTER_SECRET', 'short');
            expect(() => sealSecret('secret', 'account-a')).toThrow();
        } finally { vi.unstubAllEnvs(); }
    });
    it('creates random single-use recovery material, hashes bound to identity', () => {
        const recovery = recoveryCodes('account-a');
        expect(new Set(recovery.codes).size).toBe(10);
        expect(JSON.parse(recovery.hashes)).toContain(recoveryHash('account-a', recovery.codes[0]));
        expect(recovery.hashes).not.toContain(recovery.codes[0]);
        expect(recoveryHash('account-b', recovery.codes[0])).not.toBe(recoveryHash('account-a', recovery.codes[0]));
    });
});
