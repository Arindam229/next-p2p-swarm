import { IV_LENGTH, HASH_LENGTH } from "./crypto";

/**
 * Every WebRTC data-channel message starts with a 1-byte tag so a single
 * channel can carry both JSON control messages and binary chunk payloads.
 */
export const MSG_JSON = 0x00;
export const MSG_CHUNK = 0x01;

const HEADER_LEN = 1 + 4 + IV_LENGTH + HASH_LENGTH; // tag + index + iv + sha256

export type ControlMessage =
  | { type: "file-meta"; meta: import("@/types/transfer").FileMeta }
  | { type: "request-chunks"; fileId: string; indices: number[] }
  | { type: "have-chunks"; fileId: string; indices: number[] }
  | { type: "transfer-complete"; fileId: string };

export function encodeControlMessage(msg: ControlMessage): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(msg));
  const out = new Uint8Array(1 + body.length);
  out[0] = MSG_JSON;
  out.set(body, 1);
  return out;
}

/**
 * Binary frame layout: [1B tag][4B chunk index LE][12B IV][32B SHA-256 of
 * plaintext][ciphertext...]. The hash lets the receiver verify integrity
 * after decrypting, independent of WebRTC's own transport checks.
 */
export function encodeChunkFrame(
  index: number,
  iv: Uint8Array,
  hash: Uint8Array,
  ciphertext: ArrayBuffer
): Uint8Array {
  const cipherBytes = new Uint8Array(ciphertext);
  const out = new Uint8Array(HEADER_LEN + cipherBytes.length);
  const dv = new DataView(out.buffer);
  let offset = 1;
  dv.setUint32(offset, index, true);
  offset += 4;
  out.set(iv, offset);
  offset += IV_LENGTH;
  out.set(hash, offset);
  offset += HASH_LENGTH;
  out.set(cipherBytes, offset);
  out[0] = MSG_CHUNK;
  return out;
}

export interface ChunkFrame {
  index: number;
  iv: Uint8Array;
  hash: Uint8Array;
  ciphertext: Uint8Array;
}

export type DecodedMessage =
  | { type: "json"; payload: ControlMessage }
  | { type: "chunk"; frame: ChunkFrame };

export function decodeMessage(data: ArrayBuffer | ArrayBufferView): DecodedMessage {
  const view =
    data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);

  const tag = view[0];
  if (tag === MSG_JSON) {
    const json = new TextDecoder().decode(view.subarray(1));
    return { type: "json", payload: JSON.parse(json) as ControlMessage };
  }

  if (tag === MSG_CHUNK) {
    const dv = new DataView(view.buffer, view.byteOffset, view.byteLength);
    const index = dv.getUint32(1, true);
    const iv = view.subarray(5, 5 + IV_LENGTH);
    const hash = view.subarray(5 + IV_LENGTH, 5 + IV_LENGTH + HASH_LENGTH);
    const ciphertext = view.subarray(5 + IV_LENGTH + HASH_LENGTH);
    return { type: "chunk", frame: { index, iv, hash, ciphertext } };
  }

  throw new Error(`Unknown data-channel message tag: ${tag}`);
}
