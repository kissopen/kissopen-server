import { z } from 'zod';
import axios from 'axios';
import type { CommunityProvider } from '@kissopen/kissopen-wire';

const endpoints = {
    github: { authorize: 'https://github.com/login/oauth/authorize', token: 'https://github.com/login/oauth/access_token',
        user: 'https://api.github.com/user', scope: 'read:user', pkce: true },
    google: { authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token',
        user: 'https://openidconnect.googleapis.com/v1/userinfo', scope: 'openid profile', pkce: true },
    // NodeLoc documents a confidential-client OAuth code flow, not PKCE.
    nodeloc: { authorize: 'https://www.nodeloc.com/oauth-provider/authorize', token: 'https://www.nodeloc.com/oauth-provider/token',
        user: 'https://www.nodeloc.com/oauth-provider/userinfo', scope: 'openid profile', pkce: false },
} as const;

export function communityPublicOrigin(): string | null {
    const input = process.env.COMMUNITY_AUTH_PUBLIC_URL;
    if (!input) return null;
    const url = new URL(input);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
        throw new Error('COMMUNITY_AUTH_PUBLIC_URL must be an origin without credentials or a path');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
        throw new Error('Community OAuth requires HTTPS (HTTP is allowed only on loopback)');
    return url.origin;
}

export function communityProviderConfig(provider: CommunityProvider) {
    const origin = communityPublicOrigin();
    const prefix = `COMMUNITY_${provider.toUpperCase()}`;
    const clientId = process.env[`${prefix}_CLIENT_ID`];
    const clientSecret = process.env[`${prefix}_CLIENT_SECRET`];
    if (!origin || !clientId || !clientSecret) return null;
    return { ...endpoints[provider], clientId, clientSecret,
        redirectUri: `${origin}/v1/community/auth/${provider}/callback` };
}

const tokenSchema = z.object({ access_token: z.string().min(1), token_type: z.string() });
const githubProfile = z.object({ id: z.number().int().positive(), login: z.string().min(1), name: z.string().nullable().optional() });
const googleProfile = z.object({ sub: z.string().min(1), name: z.string().optional() });
const nodelocProfile = z.object({ id: z.number().int().positive(), username: z.string().min(1), name: z.string().optional() });

export async function communityProviderIdentity(provider: CommunityProvider, code: string, verifier: string | null) {
    const config = communityProviderConfig(provider);
    if (!config) throw new Error('Provider unavailable');
    const body = new URLSearchParams({ grant_type: 'authorization_code', code,
        client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: config.redirectUri });
    if (config.pkce) {
        if (!verifier) throw new Error('Missing PKCE verifier');
        body.set('code_verifier', verifier);
    }
    const exchanged = await axios.post(config.token, body.toString(), { timeout: 15000, maxRedirects: 0,
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' } });
    const token = tokenSchema.parse(exchanged.data);
    if (token.token_type.toLowerCase() !== 'bearer') throw new Error('Invalid token type');
    const response = await axios.get(config.user, { timeout: 15000, maxRedirects: 0,
        headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json', 'User-Agent': 'KissOpen' } });
    const profile: unknown = response.data;
    // Identity comes only from the provider's authenticated userinfo endpoint.
    // Access/refresh tokens and email addresses are never stored or sent to apps.
    if (provider === 'github') {
        const p = githubProfile.parse(profile);
        return { subject: String(p.id), name: (p.name || p.login).slice(0, 200) };
    }
    if (provider === 'google') {
        const p = googleProfile.parse(profile);
        return { subject: p.sub, name: (p.name || 'Google user').slice(0, 200) };
    }
    const p = nodelocProfile.parse(profile);
    return { subject: String(p.id), name: (p.name || p.username).slice(0, 200) };
}
