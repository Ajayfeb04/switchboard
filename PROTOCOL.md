# End-to-End Encrypted Private Notes Protocol

## Overview

Agents can leave private internal notes on a conversation for other members of the same workspace. Notes are encrypted client-side in the browser using the Web Crypto API (`AES-256-GCM`) before being sent to the Switchboard server. The server acts purely as an untrusted storage and relay layer for ciphertext.

## Key Ownership & Distribution

- **Workspace Content Key (`K_ws`)**: A 256-bit `AES-GCM` symmetric key generated in the browser via `crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])`.
- **Key Identifier (`keyId`)**: The first 8 bytes (hex-encoded) of `SHA-256(raw(K_ws))`, used by clients to select the right local key when decrypting historical notes.
- **Who holds what**:
  - **Agents / Browser Clients**: Hold `K_ws` locally in browser storage (`localStorage` scoped per workspace) and share/rotate it out-of-band (export/import key string in the Internal Notes panel).
  - **Switchboard Server & MongoDB**: Hold **zero** cryptographic keys (`K_ws` is never transmitted to the server).

## What the Server Stores

Each document in the MongoDB `notes` collection stores only:

```json
{
  "_id": "note_<uuid>",
  "workspace": "ws_acme",
  "contact": "+14155550101",
  "authorSub": "u_ben",
  "authorName": "Ben Ortiz",
  "alg": "AES-256-GCM",
  "keyId": "a1b2c3d4e5f60718",
  "iv": "<base64 96-bit random nonce>",
  "ciphertext": "<base64 AES-GCM ciphertext + 128-bit auth tag>",
  "createdAt": "2026-11-25T13:35:00.000Z"
}
```

- Every encryption generates a fresh 96-bit random IV via `crypto.getRandomValues(new Uint8Array(12))`.
- Associated Authenticated Data (AAD) binds `workspace|contact|authorSub` into the GCM tag so the server cannot silently transplant a ciphertext from one workspace/contact to another without failing GCM verification.

## Three Attacks This Scheme Does NOT Stop

1. **Malicious Server Delivering Compromised Frontend Code (Web App Integrity / XSS)**: Because the JavaScript client runs from the server origin, a compromised server (or XSS vulnerability) could serve modified frontend code that exfiltrates `K_ws` or plaintext notes before encryption.
2. **Metadata & Traffic Analysis**: The server still sees unencrypted metadata (`workspace`, `contact`, `authorSub`, `createdAt`, and ciphertext length), revealing who wrote a note, on which customer thread, when, and roughly how long the note is.
3. **Lack of Forward Secrecy / Post-Revocation Access**: Because `K_ws` is a shared workspace key, an agent who leaves the workspace (or whose device is compromised) retains the ability to decrypt all past notes encrypted under that `K_ws` unless notes are re-encrypted and a new key is distributed.
