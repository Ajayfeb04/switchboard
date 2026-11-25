// Client-side Web Crypto AES-256-GCM helper for workspace E2EE private notes.

const STORAGE_PREFIX = 'sb_e2ee_keyring_';

interface StoredKeyring {
  activeKeyId: string;
  keys: Record<string, string>; // keyId -> base64 raw 32-byte key
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function computeKeyId(rawKey: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(rawKey));
  return Array.from(new Uint8Array(digest).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function loadKeyring(workspace: string): StoredKeyring | null {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${workspace}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredKeyring;
    if (parsed && parsed.activeKeyId && parsed.keys && parsed.keys[parsed.activeKeyId]) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function saveKeyring(workspace: string, ring: StoredKeyring): void {
  localStorage.setItem(`${STORAGE_PREFIX}${workspace}`, JSON.stringify(ring));
}

export async function getOrCreateWorkspaceKey(workspace: string): Promise<{
  keyId: string;
  rawBase64: string;
  key: CryptoKey;
}> {
  const existing = loadKeyring(workspace);
  if (existing) {
    const rawBase64 = existing.keys[existing.activeKeyId];
    const key = await crypto.subtle.importKey(
      'raw',
      toArrayBuffer(fromBase64(rawBase64)),
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt']
    );
    return { keyId: existing.activeKeyId, rawBase64, key };
  }

  const generated = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
  const rawBuf = new Uint8Array(await crypto.subtle.exportKey('raw', generated));
  const keyId = await computeKeyId(rawBuf);
  const rawBase64 = toBase64(rawBuf);

  saveKeyring(workspace, {
    activeKeyId: keyId,
    keys: { [keyId]: rawBase64 },
  });

  return { keyId, rawBase64, key: generated };
}

export async function importWorkspaceKey(workspace: string, rawBase64: string): Promise<string> {
  const rawBytes = fromBase64(rawBase64.trim());
  if (rawBytes.length !== 32) {
    throw new Error('Workspace key must be a 256-bit (32-byte) base64 string');
  }
  // Validate importability before saving
  await crypto.subtle.importKey('raw', toArrayBuffer(rawBytes), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
  const keyId = await computeKeyId(rawBytes);
  const current = loadKeyring(workspace) ?? { activeKeyId: keyId, keys: {} };
  current.keys[keyId] = toBase64(rawBytes);
  current.activeKeyId = keyId;
  saveKeyring(workspace, current);
  return keyId;
}

export async function encryptNoteText(
  workspace: string,
  contact: string,
  authorSub: string,
  plaintext: string
): Promise<{ alg: 'AES-256-GCM'; keyId: string; iv: string; ciphertext: string }> {
  const { keyId, key } = await getOrCreateWorkspaceKey(workspace);
  const ivBytes = crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode(`${workspace}|${contact}|${authorSub}`);
  const pt = new TextEncoder().encode(plaintext);

  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(ivBytes), additionalData: toArrayBuffer(aad) },
    key,
    toArrayBuffer(pt)
  );

  return {
    alg: 'AES-256-GCM',
    keyId,
    iv: toBase64(ivBytes),
    ciphertext: toBase64(new Uint8Array(ct)),
  };
}

export async function decryptNoteText(
  workspace: string,
  contact: string,
  authorSub: string,
  keyId: string,
  iv: string,
  ciphertext: string
): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  const ring = loadKeyring(workspace);
  const rawBase64 = ring?.keys[keyId];
  if (!rawBase64) {
    return { ok: false, reason: `Missing workspace key (${keyId})` };
  }

  try {
    const key = await crypto.subtle.importKey(
      'raw',
      toArrayBuffer(fromBase64(rawBase64)),
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    );
    const aad = new TextEncoder().encode(`${workspace}|${contact}|${authorSub}`);
    const pt = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: toArrayBuffer(fromBase64(iv)),
        additionalData: toArrayBuffer(aad),
      },
      key,
      toArrayBuffer(fromBase64(ciphertext))
    );
    return { ok: true, text: new TextDecoder().decode(pt) };
  } catch {
    return { ok: false, reason: 'Decryption failed (key or AAD mismatch)' };
  }
}
