"use client";

import { useEffect, useRef, useState } from "react";
import SimplePeer from "simple-peer";
import { toast } from "sonner";

import "@/lib/polyfills";
import { getSocket } from "@/lib/socket";
import { ChunkStore } from "@/lib/storage";
import {
  bytesEqual,
  decryptChunk,
  encryptChunk,
  importKeyFromString,
  sha256Bytes,
} from "@/lib/crypto";
import {
  ChunkFrame,
  ControlMessage,
  decodeMessage,
  encodeChunkFrame,
  encodeControlMessage,
} from "@/lib/protocol";
import type {
  ConnectionStatus,
  FileMeta,
  PeerStatus,
  TransferRole,
} from "@/types/transfer";

export const CHUNK_SIZE = 32 * 1024; // 32KB per spec
const REQUEST_BATCH_SIZE = 8;
const MAX_IN_FLIGHT_PER_PEER = 24;
const IN_FLIGHT_TIMEOUT_MS = 8000;
const TICK_INTERVAL_MS = 500;
const HAVE_CHUNKS_THROTTLE_MS = 1000;
const SPEED_WINDOW_MS = 4000;

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

interface PeerEntry {
  id: string;
  peer: SimplePeer.Instance;
  connected: boolean;
  chunksAvailable: Set<number>;
}

export interface UseP2POptions {
  roomId: string;
  /** Present only on the browser tab that originated the share. */
  file?: File | null;
  /** Base64url AES-GCM key, read from the URL `#key=` fragment. */
  encryptionKey: string | null;
}

export interface UseP2PResult {
  status: ConnectionStatus;
  role: TransferRole;
  peers: PeerStatus[];
  fileMeta: FileMeta | null;
  progress: number;
  speedBps: number;
  etaSeconds: number | null;
  isPaused: boolean;
  isComplete: boolean;
  error: string | null;
}

function fullSet(n: number): Set<number> {
  const s = new Set<number>();
  for (let i = 0; i < n; i++) s.add(i);
  return s;
}

function toUint8Array(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new Error("Unsupported data-channel payload type");
}

export function useP2P({ roomId, file, encryptionKey }: UseP2POptions): UseP2PResult {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [role, setRole] = useState<TransferRole>(file ? "sender" : "idle");
  const [peers, setPeers] = useState<PeerStatus[]>([]);
  const [fileMeta, setFileMeta] = useState<FileMeta | null>(null);
  const [progress, setProgress] = useState(0);
  const [speedBps, setSpeedBps] = useState(0);
  const [etaSeconds, setEtaSeconds] = useState<number | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refs hold the "live" mutable state that the socket/peer event handlers
  // close over. React state above is just a periodically-synced projection
  // for rendering.
  const fileRef = useRef<File | null>(file ?? null);
  const roleRef = useRef<TransferRole>(file ? "sender" : "idle");
  const aesKeyRef = useRef<CryptoKey | null>(null);
  const fileMetaRef = useRef<FileMeta | null>(null);
  const peersRef = useRef<Map<string, PeerEntry>>(new Map());
  const chunkStoreRef = useRef<ChunkStore | null>(null);
  const chunkStorePromiseRef = useRef<Promise<ChunkStore> | null>(null);
  const myChunksRef = useRef<Set<number>>(new Set());
  const sentChunksRef = useRef<Set<number>>(new Set());
  const inFlightRef = useRef<Map<number, { peerId: string; at: number }>>(new Map());
  const pendingHaveRef = useRef<Set<number>>(new Set());
  const lastHaveBroadcastRef = useRef(0);
  const bytesWindowRef = useRef<{ time: number; bytes: number }[]>([]);
  const wasConnectedRef = useRef(false);
  const isCompleteRef = useRef(false);

  useEffect(() => {
    fileRef.current = file ?? null;

    if (!encryptionKey) {
      setError("Missing decryption key in the URL. Use the full share link.");
      setStatus("disconnected");
      return;
    }

    setError(null);
    setStatus("connecting");

    let cancelled = false;
    const socket = getSocket();
    const frameCacheRef = { current: new Map<number, Uint8Array>() };

    const updatePeersState = () => {
      setPeers(
        [...peersRef.current.values()].map((p) => ({ id: p.id, connected: p.connected }))
      );
    };

    const recomputeStatus = () => {
      const connected = [...peersRef.current.values()].filter((p) => p.connected);
      if (isCompleteRef.current) {
        setStatus("connected");
      } else if (connected.length === 0) {
        setStatus(peersRef.current.size === 0 && wasConnectedRef.current === false ? "connecting" : "disconnected");
      } else if (connected.length >= 2) {
        setStatus("swarm");
        wasConnectedRef.current = true;
      } else if (!fileMetaRef.current) {
        setStatus("syncing");
        wasConnectedRef.current = true;
      } else {
        setStatus("connected");
        wasConnectedRef.current = true;
      }
    };

    const sendControl = (entry: PeerEntry, msg: ControlMessage) => {
      try {
        entry.peer.send(encodeControlMessage(msg));
      } catch {
        // Channel not open yet or already closed - safe to ignore.
      }
    };

    const flushHaveChunks = (force: boolean) => {
      const now = performance.now();
      if (!force && now - lastHaveBroadcastRef.current < HAVE_CHUNKS_THROTTLE_MS) return;
      if (pendingHaveRef.current.size === 0) return;
      const meta = fileMetaRef.current;
      if (!meta) return;

      lastHaveBroadcastRef.current = now;
      const indices = [...pendingHaveRef.current];
      pendingHaveRef.current.clear();
      for (const entry of peersRef.current.values()) {
        if (entry.connected) {
          sendControl(entry, { type: "have-chunks", fileId: meta.id, indices });
        }
      }
    };

    const scheduleRequests = () => {
      const meta = fileMetaRef.current;
      if (!meta || roleRef.current !== "receiver") return;

      const now = performance.now();
      for (const [index, info] of inFlightRef.current) {
        if (now - info.at > IN_FLIGHT_TIMEOUT_MS) inFlightRef.current.delete(index);
      }

      const connectedPeers = [...peersRef.current.values()].filter((p) => p.connected);
      if (connectedPeers.length === 0) {
        if (myChunksRef.current.size < meta.totalChunks && !isCompleteRef.current) {
          setIsPaused(true);
        }
        return;
      }
      setIsPaused(false);

      for (const entry of connectedPeers) {
        let inFlightForPeer = 0;
        for (const info of inFlightRef.current.values()) {
          if (info.peerId === entry.id) inFlightForPeer++;
        }
        let slots = Math.min(MAX_IN_FLIGHT_PER_PEER - inFlightForPeer, REQUEST_BATCH_SIZE);
        if (slots <= 0) continue;

        const batch: number[] = [];
        for (let i = 0; i < meta.totalChunks && slots > 0; i++) {
          if (myChunksRef.current.has(i) || inFlightRef.current.has(i)) continue;
          if (!entry.chunksAvailable.has(i)) continue;
          batch.push(i);
          inFlightRef.current.set(i, { peerId: entry.id, at: now });
          slots--;
        }
        if (batch.length > 0) {
          sendControl(entry, { type: "request-chunks", fileId: meta.id, indices: batch });
        }
      }
    };

    const completeTransfer = async () => {
      const meta = fileMetaRef.current;
      if (!meta || isCompleteRef.current) return;
      isCompleteRef.current = true;
      setIsComplete(true);
      setProgress(100);
      setEtaSeconds(0);
      setIsPaused(false);

      try {
        await chunkStoreRef.current?.finalize(meta.name, meta.mime);
        toast.success(`"${meta.name}" downloaded successfully.`);
      } catch (e) {
        console.error("Failed to finalize download", e);
        toast.error("Transfer finished but saving the file failed.");
      }

      for (const entry of peersRef.current.values()) {
        if (entry.connected) {
          sendControl(entry, { type: "transfer-complete", fileId: meta.id });
        }
      }
      recomputeStatus();
    };

    const ensureChunkStore = (meta: FileMeta) => {
      if (chunkStoreRef.current || chunkStorePromiseRef.current) return;
      chunkStorePromiseRef.current = ChunkStore.create({
        fileId: meta.id,
        chunkSize: meta.chunkSize,
        totalChunks: meta.totalChunks,
      }).then((store) => {
        chunkStoreRef.current = store;
        return store;
      });
    };

    const serveChunkRequest = async (entry: PeerEntry, indices: number[]) => {
      const meta = fileMetaRef.current;
      const key = aesKeyRef.current;
      if (!meta || !key) return;

      for (const index of indices) {
        if (roleRef.current === "sender" && fileRef.current) {
          const start = index * meta.chunkSize;
          const end = Math.min(start + meta.chunkSize, meta.size);
          try {
            const buf = await fileRef.current.slice(start, end).arrayBuffer();
            const hash = await sha256Bytes(buf);
            const { iv, ciphertext } = await encryptChunk(key, buf);
            const frame = encodeChunkFrame(index, iv, hash, ciphertext);
            entry.peer.send(frame);
            if (!sentChunksRef.current.has(index)) {
              sentChunksRef.current.add(index);
            }
          } catch (e) {
            console.error("Failed to read/encrypt chunk", index, e);
          }
        } else {
          // Swarm relay: forward the exact frame we previously verified,
          // no decrypt/re-encrypt needed.
          const cached = frameCacheRef.current.get(index);
          if (cached) {
            try {
              entry.peer.send(cached);
            } catch {
              // ignore - requester will time out and re-request elsewhere
            }
          }
        }
      }
    };

    const handleControlMessage = (entry: PeerEntry, msg: ControlMessage) => {
      switch (msg.type) {
        case "file-meta": {
          if (!fileMetaRef.current) {
            fileMetaRef.current = msg.meta;
            setFileMeta(msg.meta);
            if (roleRef.current === "idle") {
              roleRef.current = "receiver";
              setRole("receiver");
              ensureChunkStore(msg.meta);
            }
          }
          recomputeStatus();
          scheduleRequests();
          break;
        }
        case "have-chunks": {
          for (const idx of msg.indices) entry.chunksAvailable.add(idx);
          scheduleRequests();
          break;
        }
        case "request-chunks": {
          void serveChunkRequest(entry, msg.indices);
          break;
        }
        case "transfer-complete": {
          // Informational only - completion is driven by our own chunk count.
          break;
        }
        default:
          break;
      }
    };

    const handleChunkFrame = async (entry: PeerEntry, frame: ChunkFrame, raw: Uint8Array) => {
      const meta = fileMetaRef.current;
      const key = aesKeyRef.current;
      if (!meta || !key) return;
      if (roleRef.current !== "receiver") return;
      if (myChunksRef.current.has(frame.index)) {
        inFlightRef.current.delete(frame.index);
        return;
      }

      try {
        const plaintext = await decryptChunk(key, frame.iv, frame.ciphertext);
        const hash = await sha256Bytes(plaintext);
        if (!bytesEqual(hash, frame.hash)) {
          inFlightRef.current.delete(frame.index);
          return;
        }

        await chunkStorePromiseRef.current;
        await chunkStoreRef.current?.writeChunk(frame.index, plaintext);

        frameCacheRef.current.set(frame.index, raw.slice());
        myChunksRef.current.add(frame.index);
        pendingHaveRef.current.add(frame.index);
        inFlightRef.current.delete(frame.index);
        bytesWindowRef.current.push({ time: performance.now(), bytes: plaintext.byteLength });

        flushHaveChunks(false);

        if (myChunksRef.current.size === meta.totalChunks) {
          await completeTransfer();
        }
      } catch (e) {
        console.error("Chunk decode error", e);
        inFlightRef.current.delete(frame.index);
      }
    };

    const createPeerEntry = (id: string, initiator: boolean): PeerEntry => {
      const existing = peersRef.current.get(id);
      if (existing) return existing;

      const peer = new SimplePeer({
        initiator,
        trickle: true,
        config: { iceServers: ICE_SERVERS },
      });

      const entry: PeerEntry = { id, peer, connected: false, chunksAvailable: new Set() };
      peersRef.current.set(id, entry);

      peer.on("signal", (signal) => {
        socket.emit("signal", { to: id, signal });
      });

      peer.on("connect", () => {
        entry.connected = true;
        updatePeersState();

        if (fileMetaRef.current) {
          sendControl(entry, { type: "file-meta", meta: fileMetaRef.current });
        }
        if (myChunksRef.current.size > 0 && fileMetaRef.current) {
          sendControl(entry, {
            type: "have-chunks",
            fileId: fileMetaRef.current.id,
            indices: [...myChunksRef.current],
          });
        }

        if (wasConnectedRef.current) {
          toast.success("Peer reconnected - resuming transfer.");
        }
        wasConnectedRef.current = true;

        recomputeStatus();
        scheduleRequests();
      });

      peer.on("data", (data: unknown) => {
        try {
          const bytes = toUint8Array(data);
          const decoded = decodeMessage(bytes);
          if (decoded.type === "json") {
            handleControlMessage(entry, decoded.payload);
          } else {
            void handleChunkFrame(entry, decoded.frame, bytes);
          }
        } catch (e) {
          console.error("Bad data-channel message", e);
        }
      });

      const handleDrop = () => {
        if (!entry.connected) return;
        entry.connected = false;
        updatePeersState();

        for (const [index, info] of inFlightRef.current) {
          if (info.peerId === id) inFlightRef.current.delete(index);
        }

        if (!isCompleteRef.current && roleRef.current === "receiver") {
          toast.warning("Peer disconnected. Pausing - will resume automatically.");
        }

        recomputeStatus();
        scheduleRequests();
      };

      peer.on("close", handleDrop);
      peer.on("error", (err) => {
        console.warn("Peer error", id, err.message);
        handleDrop();
      });

      updatePeersState();
      return entry;
    };

    const destroyPeer = (id: string) => {
      const entry = peersRef.current.get(id);
      if (!entry) return;
      entry.connected = false;
      try {
        entry.peer.destroy();
      } catch {
        // ignore
      }
      peersRef.current.delete(id);

      for (const [index, info] of inFlightRef.current) {
        if (info.peerId === id) inFlightRef.current.delete(index);
      }

      updatePeersState();
      if (!isCompleteRef.current && roleRef.current === "receiver") {
        toast.warning("Peer disconnected. Pausing - will resume automatically.");
      }
      recomputeStatus();
      scheduleRequests();
    };

    const onRoomPeers = (existingIds: string[]) => {
      for (const id of existingIds) createPeerEntry(id, false);
      recomputeStatus();
    };

    const onPeerJoined = (id: string) => {
      createPeerEntry(id, true);
    };

    const onSignal = ({ from, signal }: { from: string; signal: SimplePeer.SignalData }) => {
      const entry = createPeerEntry(from, false);
      try {
        entry.peer.signal(signal);
      } catch (e) {
        console.error("Failed to apply signal", e);
      }
    };

    const onPeerLeft = (id: string) => {
      destroyPeer(id);
    };

    const joinRoom = () => socket.emit("join-room", roomId);

    (async () => {
      try {
        aesKeyRef.current = await importKeyFromString(encryptionKey);
      } catch {
        if (!cancelled) {
          setError("Invalid decryption key.");
          setStatus("disconnected");
        }
        return;
      }
      if (cancelled) return;

      if (fileRef.current) {
        const f = fileRef.current;
        const totalChunks = Math.max(1, Math.ceil(f.size / CHUNK_SIZE));
        const meta: FileMeta = {
          id: roomId,
          name: f.name,
          size: f.size,
          mime: f.type || "application/octet-stream",
          chunkSize: CHUNK_SIZE,
          totalChunks,
        };
        fileMetaRef.current = meta;
        setFileMeta(meta);
        roleRef.current = "sender";
        setRole("sender");
        myChunksRef.current = fullSet(totalChunks);
      }

      socket.on("room-peers", onRoomPeers);
      socket.on("peer-joined", onPeerJoined);
      socket.on("signal", onSignal);
      socket.on("peer-left", onPeerLeft);
      socket.on("connect", joinRoom);
      
      if (socket.connected) {
        joinRoom();
      } else {
        joinRoom();
      }
    })();

    const tick = () => {
      const now = performance.now();
      bytesWindowRef.current = bytesWindowRef.current.filter(
        (e) => now - e.time < SPEED_WINDOW_MS
      );

      const windowBytes = bytesWindowRef.current.reduce((s, e) => s + e.bytes, 0);
      const span = bytesWindowRef.current.length
        ? Math.max((now - bytesWindowRef.current[0].time) / 1000, 0.25)
        : 1;
      const speed = windowBytes / span;
      setSpeedBps(speed);

      const meta = fileMetaRef.current;
      if (meta) {
        if (roleRef.current === "receiver") {
          const done = myChunksRef.current.size;
          const pct = (done / meta.totalChunks) * 100;
          setProgress(pct);
          if (!isCompleteRef.current) {
            const remaining = meta.size - done * meta.chunkSize;
            setEtaSeconds(speed > 1024 ? Math.max(remaining, 0) / speed : null);
          }
        } else if (roleRef.current === "sender") {
          const pct = (sentChunksRef.current.size / meta.totalChunks) * 100;
          setProgress(pct);
        }
      }

      flushHaveChunks(true);
      scheduleRequests();
    };

    const interval = setInterval(tick, TICK_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
      socket.off("room-peers", onRoomPeers);
      socket.off("peer-joined", onPeerJoined);
      socket.off("signal", onSignal);
      socket.off("peer-left", onPeerLeft);
      socket.off("connect", joinRoom);
      for (const entry of peersRef.current.values()) {
        try {
          entry.peer.destroy();
        } catch {
          // ignore
        }
      }
      peersRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, encryptionKey, file]);

  return {
    status,
    role,
    peers,
    fileMeta,
    progress,
    speedBps,
    etaSeconds,
    isPaused,
    isComplete,
    error,
  };
}
