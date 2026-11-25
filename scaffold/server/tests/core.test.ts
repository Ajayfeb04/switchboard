import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { generatePkcePair, parseCookies, verifyPigeonSignature } from '../src/lib/crypto.js';
import { canTransitionOutboundStatus } from '../src/services/inbound.js';

function signBody(body: string, secret: string, ts: number): string {
  const mac = crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  return `t=${ts},v1=${mac}`;
}

test('verifyPigeonSignature accepts a valid, fresh signature', () => {
  const secret = 'whsec_test_secret';
  const raw = Buffer.from(JSON.stringify({ id: 'evt_1', type: 'message.inbound' }), 'utf8');
  const now = Math.floor(Date.now() / 1000);
  const header = signBody(raw.toString('utf8'), secret, now - 10);

  const res = verifyPigeonSignature(raw, header, secret, 300);
  assert.equal(res.ok, true);
});

test('verifyPigeonSignature rejects missing, malformed, and wrong-secret signatures', () => {
  const secret = 'whsec_test_secret';
  const raw = Buffer.from('{"hello":"world"}', 'utf8');
  const now = Math.floor(Date.now() / 1000);

  assert.deepEqual(verifyPigeonSignature(raw, undefined, secret), { ok: false, reason: 'missing' });
  assert.deepEqual(verifyPigeonSignature(raw, 'bad-header', secret), { ok: false, reason: 'malformed' });
  assert.deepEqual(verifyPigeonSignature(raw, `t=${now},v1=not_hex`, secret), { ok: false, reason: 'malformed' });

  const forged = signBody(raw.toString('utf8'), 'wrong_secret', now);
  assert.deepEqual(verifyPigeonSignature(raw, forged, secret), { ok: false, reason: 'mismatch' });

  const tampered = Buffer.from('{"hello":"tampered"}', 'utf8');
  const validForOriginal = signBody(raw.toString('utf8'), secret, now);
  assert.deepEqual(verifyPigeonSignature(tampered, validForOriginal, secret), { ok: false, reason: 'mismatch' });
});

test('verifyPigeonSignature rejects timestamps older than 5 minutes', () => {
  const secret = 'whsec_test_secret';
  const raw = Buffer.from('{"id":"evt_old"}', 'utf8');
  const staleTs = Math.floor(Date.now() / 1000) - 3600;
  const header = signBody(raw.toString('utf8'), secret, staleTs);

  assert.deepEqual(verifyPigeonSignature(raw, header, secret, 300), { ok: false, reason: 'stale' });
});

test('canTransitionOutboundStatus enforces forward-only status lifecycle', () => {
  assert.equal(canTransitionOutboundStatus('queued', 'sent'), true);
  assert.equal(canTransitionOutboundStatus('queued', 'delivered'), true);
  assert.equal(canTransitionOutboundStatus('queued', 'failed'), true);
  assert.equal(canTransitionOutboundStatus('sent', 'delivered'), true);
  assert.equal(canTransitionOutboundStatus('sent', 'failed'), true);

  // Out-of-order `sent` arriving after `delivered`/`failed` must be ignored
  assert.equal(canTransitionOutboundStatus('delivered', 'sent'), false);
  assert.equal(canTransitionOutboundStatus('failed', 'sent'), false);
  assert.equal(canTransitionOutboundStatus('delivered', 'delivered'), false);
  assert.equal(canTransitionOutboundStatus('sent', 'sent'), false);
});

test('generatePkcePair produces valid S256 challenge for verifier', () => {
  const { codeVerifier, codeChallenge } = generatePkcePair();
  const expected = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  assert.equal(codeChallenge, expected);
  assert.ok(codeVerifier.length >= 40);
});

test('parseCookies decodes multiple cookies safely', () => {
  const parsed = parseCookies('foo=bar; sb_session=abc%2B123%3D%3D; theme=light');
  assert.deepEqual(parsed, {
    foo: 'bar',
    sb_session: 'abc+123==',
    theme: 'light',
  });
});
