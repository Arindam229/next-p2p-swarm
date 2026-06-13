/**
 * Zero-knowledge AES-GCM helpers built on the browser Web Crypto API.
 * The signaling server never sees keys, plaintext, or even ciphertext -
 * everything here runs purely client-side.
 */

const AES_ALGO = "AES-GCM";
const KEY_LENGTH = 256;
export const IV_LENGTH = 12; // bytes, recommended nonce size for AES-GCM
export const HASH_LENGTH = 32; // SHA-256 digest size in bytes

export async function generateEncryptionKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: AES_ALGO, length: KEY_LENGTH }, true, [
    "encrypt",
    "decrypt",
  ]);
}

/** Exports a key as a URL-safe base64 string, suitable for a `#key=` fragment. */
export async function exportKeyToString(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", key);
  return bufferToBase64Url(raw);
}

export async function importKeyFromString(keyStr: string): Promise<CryptoKey> {
  const raw = base64UrlToBuffer(keyStr);
  return crypto.subtle.importKey("raw", raw, AES_ALGO, true, ["encrypt", "decrypt"]);
}

export async function encryptChunk(
  key: CryptoKey,
  data: ArrayBuffer
): Promise<{ iv: Uint8Array; ciphertext: ArrayBuffer }> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = await crypto.subtle.encrypt({ name: AES_ALGO, iv }, key, data);
  return { iv, ciphertext };
}

export async function decryptChunk(
  key: CryptoKey,
  iv: Uint8Array,
  ciphertext: ArrayBuffer | ArrayBufferView
): Promise<ArrayBuffer> {
  return crypto.subtle.decrypt(
    { name: AES_ALGO, iv: iv as unknown as BufferSource },
    key,
    ciphertext as unknown as BufferSource
  );
}

/** Raw SHA-256 digest bytes - used for per-chunk integrity verification. */
export async function sha256Bytes(data: ArrayBuffer | ArrayBufferView): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", data as unknown as BufferSource);
  return new Uint8Array(digest);
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function bufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBuffer(base64Url: string): ArrayBuffer {
  const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = base64.length % 4 === 0 ? "" : "=".repeat(4 - (base64.length % 4));
  const binary = atob(base64 + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
