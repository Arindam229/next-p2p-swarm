export interface FileMeta {
  id: string;
  name: string;
  size: number;
  mime: string;
  chunkSize: number;
  totalChunks: number;
}

export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "syncing"
  | "connected"
  | "swarm"
  | "disconnected";

export type TransferRole = "idle" | "sender" | "receiver";

export interface PeerStatus {
  id: string;
  connected: boolean;
}

export interface TransferStats {
  progress: number; // 0-100
  speedBps: number;
  etaSeconds: number | null;
  bytesDone: number;
}
