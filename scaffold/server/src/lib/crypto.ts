import crypto from 'node:crypto';

export type SignatureCheckResult =
  | { ok: true; timestamp: number }
  | { ok: false; reason: 'missing' | 'malformed' | 'mismatch' | 'stale' };

/**
 * Verify Pigeon's `x-pigeon-signature: t=<unix>,v1=<hex>` header against the
 * exact raw request body and reject timestamps older/newer than maxAgeSec.
 */
export function verifyPigeonSignature(
  rawBody: Buffer,
  header: string | undefined,
  secret: string,
  maxAgeSec = 300
): SignatureCheckResult {
  if (!header || typeof header !== 'string') {
    return { ok: false, reason: 'missing' };
  }

  let tsStr: string | undefined;
  let v1Hex: string | undefined;
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (key === 't') tsStr = val;
    else if (key === 'v1') v1Hex = val;
  }

  if (!tsStr || !v1Hex || !/^\d+$/.test(tsStr) || !/^[0-9a-fA-F]+$/.test(v1Hex)) {
    return { ok: false, reason: 'malformed' };
  }

  const timestamp = Number(tsStr);
  if (!Number.isSafeInteger(timestamp)) {
    return { ok: false, reason: 'malformed' };
  }

  const payload = Buffer.concat([Buffer.from(`${tsStr}.`, 'utf8'), rawBody]);
  const expected = crypto.createHmac('sha256', secret).update(payload).digest();
  const actual = Buffer.from(v1Hex, 'hex');

  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return { ok: false, reason: 'mismatch' };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - timestamp) > maxAgeSec) {
    return { ok: false, reason: 'stale' };
  }

  return { ok: true, timestamp };
}

export function generatePkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

export function randomToken(bytes = 24): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const pair of cookieHeader.split(';')) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  }
  return out;
}
