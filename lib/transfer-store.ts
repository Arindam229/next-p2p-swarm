/**
 * In-memory hand-off so the file a user dropped on the home page survives
 * the client-side navigation to /room/[id] without ever touching the
 * network or persistent storage.
 */

interface PendingShare {
  roomId: string;
  file: File;
  key: string;
}

let pending: PendingShare | null = null;

export function setPendingShare(share: PendingShare): void {
  pending = share;
}

/** Consumes the pending share if it matches this room - one-shot. */
export function takePendingShare(roomId: string): PendingShare | null {
  if (pending && pending.roomId === roomId) {
    const result = pending;
    pending = null;
    return result;
  }
  return null;
}
