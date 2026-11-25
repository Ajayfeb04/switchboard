import crypto from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { config } from '../config.js';
import { generatePkcePair, parseCookies, randomToken } from '../lib/crypto.js';
import { getRedis } from '../redis.js';

export interface WorkspaceMembership {
  id: string;
  role: 'admin' | 'agent' | string;
}

export interface SessionUser {
  sub: string;
  name?: string;
  email?: string;
  workspaces: WorkspaceMembership[];
}

export interface AuthenticatedRequest extends Request {
  session?: SessionUser;
  sessionId?: string;
}

interface JwkKey {
  kid?: string;
  kty: string;
  n?: string;
  e?: string;
  [key: string]: unknown;
}

let cachedJwks: Map<string, crypto.KeyObject> = new Map();

async function getVerificationKey(kid: string | undefined): Promise<crypto.KeyObject | null> {
  if (kid && cachedJwks.has(kid)) {
    return cachedJwks.get(kid)!;
  }

  const res = await fetch(`${config.oidc.issuer}/jwks`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) return null;
  const body = (await res.json()) as { keys?: JwkKey[] };
  const next = new Map<string, crypto.KeyObject>();
  for (const jwk of body.keys ?? []) {
    try {
      const keyObj = crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: 'jwk' });
      if (jwk.kid) next.set(jwk.kid, keyObj);
      else next.set('default', keyObj);
    } catch {
      // skip invalid key entries
    }
  }
  cachedJwks = next;
  return (kid ? cachedJwks.get(kid) : undefined) ?? cachedJwks.get('default') ?? null;
}

async function verifyIdToken(idToken: string, expectedNonce: string): Promise<SessionUser | null> {
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;

  let header: { alg?: string; kid?: string };
  let claims: {
    iss?: string;
    aud?: string | string[];
    sub?: string;
    exp?: number;
    nonce?: string;
    name?: string;
    email?: string;
    workspaces?: WorkspaceMembership[];
  };

  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8')) as typeof header;
    claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as typeof claims;
  } catch {
    return null;
  }

  if (header.alg !== 'RS256') return null;
  const pubKey = await getVerificationKey(header.kid);
  if (!pubKey) return null;

  const validSig = crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${headerB64}.${payloadB64}`),
    pubKey,
    Buffer.from(sigB64, 'base64url')
  );
  if (!validSig) return null;

  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== config.oidc.issuer) return null;
  const audMatch = Array.isArray(claims.aud)
    ? claims.aud.includes(config.oidc.clientId)
    : claims.aud === config.oidc.clientId;
  if (!audMatch) return null;
  if (!claims.exp || claims.exp < now) return null;
  if (expectedNonce && claims.nonce !== expectedNonce) return null;
  if (!claims.sub) return null;

  return {
    sub: claims.sub,
    name: claims.name,
    email: claims.email,
    workspaces: Array.isArray(claims.workspaces) ? claims.workspaces : [],
  };
}

export async function loadSessionFromCookie(cookieHeader: string | undefined): Promise<{
  sessionId: string;
  user: SessionUser;
} | null> {
  const cookies = parseCookies(cookieHeader);
  const sessionId = cookies.sb_session;
  if (!sessionId) return null;

  const raw = await getRedis().get(`sess:${sessionId}`);
  if (!raw) return null;

  try {
    const user = JSON.parse(raw) as SessionUser;
    if (!user?.sub) return null;
    return { sessionId, user };
  } catch {
    return null;
  }
}

export async function requireSession(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const loaded = await loadSessionFromCookie(req.headers.cookie);
  if (!loaded) {
    res.status(401).json({ error: 'authentication required' });
    return;
  }
  req.session = loaded.user;
  req.sessionId = loaded.sessionId;
  next();
}

export const authRouter = Router();

authRouter.get('/auth/login', async (req: Request, res: Response) => {
  const state = randomToken(24);
  const nonce = randomToken(16);
  const { codeVerifier, codeChallenge } = generatePkcePair();

  await getRedis().set(
    `oidc:state:${state}`,
    JSON.stringify({ codeVerifier, nonce }),
    'EX',
    600
  );

  const authUrl = new URL(`${config.oidc.issuer}/authorize`);
  authUrl.searchParams.set('client_id', config.oidc.clientId);
  authUrl.searchParams.set('redirect_uri', config.oidc.redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'openid profile email');
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('nonce', nonce);

  res.redirect(302, authUrl.toString());
});

authRouter.get('/auth/callback', async (req: Request, res: Response) => {
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';

  if (!code || !state) {
    res.status(400).json({ error: 'missing code or state' });
    return;
  }

  const r = getRedis();
  const txRaw = await r.getdel(`oidc:state:${state}`);
  if (!txRaw) {
    res.status(400).json({ error: 'invalid or expired login state' });
    return;
  }

  const tx = JSON.parse(txRaw) as { codeVerifier: string; nonce: string };

  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.oidc.redirectUri,
    client_id: config.oidc.clientId,
    client_secret: config.oidc.clientSecret,
    code_verifier: tx.codeVerifier,
  });

  const tokenRes = await fetch(`${config.oidc.issuer}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    signal: AbortSignal.timeout(5000),
  });

  if (!tokenRes.ok) {
    res.status(401).json({ error: 'token exchange failed' });
    return;
  }

  const tokens = (await tokenRes.json()) as { id_token?: string };
  if (!tokens.id_token) {
    res.status(401).json({ error: 'missing id_token' });
    return;
  }

  const user = await verifyIdToken(tokens.id_token, tx.nonce);
  if (!user) {
    res.status(401).json({ error: 'invalid id_token' });
    return;
  }

  const sessionId = randomToken(32);
  await r.set(`sess:${sessionId}`, JSON.stringify(user), 'EX', 86400);

  res.setHeader(
    'Set-Cookie',
    `sb_session=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`
  );
  res.redirect(302, config.webOrigin);
});

authRouter.post('/auth/logout', async (req: Request, res: Response) => {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.sb_session) {
    await getRedis().del(`sess:${cookies.sb_session}`);
  }
  res.setHeader('Set-Cookie', 'sb_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.status(200).json({ ok: true });
});

authRouter.get('/api/me', requireSession, (req: AuthenticatedRequest, res: Response) => {
  const u = req.session!;
  res.status(200).json({
    sub: u.sub,
    name: u.name,
    email: u.email,
    workspaces: u.workspaces,
  });
});
