import { x25519 } from '@noble/curves/ed25519.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { bytesToHex, hexToBytes, isHex, type Hex } from 'viem';

/**
 * Sealed box for sending secrets to a bounty's agent (the `encKey` posted on-chain).
 * Format (hex): 0x01 | ephemeralPub(32) | nonce(24) | xchacha20poly1305 ciphertext+tag.
 * key = HKDF-SHA256(x25519(eph, agentPub), salt = ephPub || agentPub, info = "madbounty-box-v1").
 */
const VERSION = 0x01;
const INFO = new TextEncoder().encode('madbounty-box-v1');

export interface EncryptionKeyPair {
  privateKey: Hex;
  publicKey: Hex;
}

function toBytes(k: Hex | Uint8Array, len: number, what: string): Uint8Array {
  const b = typeof k === 'string' ? (isHex(k) ? hexToBytes(k) : (() => { throw new Error(`${what}: not hex`); })()) : k;
  if (b.length !== len) throw new Error(`${what}: expected ${len} bytes, got ${b.length}`);
  return b;
}

function deriveKey(shared: Uint8Array, ephPub: Uint8Array, recipPub: Uint8Array): Uint8Array {
  const salt = new Uint8Array(64);
  salt.set(ephPub, 0);
  salt.set(recipPub, 32);
  return hkdf(sha256, shared, salt, INFO, 32);
}

export function generateEncryptionKeyPair(): EncryptionKeyPair {
  const priv = x25519.utils.randomSecretKey();
  return { privateKey: bytesToHex(priv), publicKey: bytesToHex(x25519.getPublicKey(priv)) };
}

export function encryptionPublicKey(privateKey: Hex | Uint8Array): Hex {
  return bytesToHex(x25519.getPublicKey(toBytes(privateKey, 32, 'privateKey')));
}

export function encryptForAgent(agentPubKey: Hex | Uint8Array, plaintext: string | Uint8Array): Hex {
  const recip = toBytes(agentPubKey, 32, 'agentPubKey');
  const eph = x25519.utils.randomSecretKey();
  const ephPub = x25519.getPublicKey(eph);
  const key = deriveKey(x25519.getSharedSecret(eph, recip), ephPub, recip);
  const nonce = randomBytes(24);
  const msg = typeof plaintext === 'string' ? new TextEncoder().encode(plaintext) : plaintext;
  const ct = xchacha20poly1305(key, nonce).encrypt(msg);
  const out = new Uint8Array(1 + 32 + 24 + ct.length);
  out[0] = VERSION;
  out.set(ephPub, 1);
  out.set(nonce, 33);
  out.set(ct, 57);
  return bytesToHex(out);
}

/** Throws if the box was tampered with or is for a different key. */
export function decryptAsAgent(privKey: Hex | Uint8Array, box: Hex | Uint8Array): Uint8Array {
  const priv = toBytes(privKey, 32, 'privKey');
  const b = typeof box === 'string' ? hexToBytes(box) : box;
  if (b.length < 1 + 32 + 24 + 16 || b[0] !== VERSION) throw new Error('decryptAsAgent: bad box');
  const ephPub = b.slice(1, 33);
  const nonce = b.slice(33, 57);
  const ct = b.slice(57);
  const myPub = x25519.getPublicKey(priv);
  const key = deriveKey(x25519.getSharedSecret(priv, ephPub), ephPub, myPub);
  return xchacha20poly1305(key, nonce).decrypt(ct);
}

export function decryptAsAgentString(privKey: Hex | Uint8Array, box: Hex | Uint8Array): string {
  return new TextDecoder().decode(decryptAsAgent(privKey, box));
}
