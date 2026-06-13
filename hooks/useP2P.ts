"use client";

import { useEffect, useRef, useState } from "react";
import SimplePeer from "simple-peer";
import { toast } from "sonner";
import { v4 as uuidv4 } from "uuid";

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

export interface FileTransferState {
  meta: FileMeta;
  progress: number;
  speedBps: number;
  etaSeconds: number | null;
  isPaused: boolean;
  isComplete: boolean;
  error: string | null;
  role: TransferRole;
}

interface PeerEntry {
  id: string;
  peer: SimplePeer.Instance;
  connected: boolean;
  chunksAvailable: Map<string, Set<number>>;
}

export interface UseP2POptions {
  roomId: string;
  initialFile?: File | null;
  /** Base64url AES-GCM key, read from the URL `#key=` fragment. */
  encryptionKey: string | null;
}

export interface UseP2PResult {
  status: ConnectionStatus;
  peers: PeerStatus[];
  files: Record<string, FileTransferState>;
  addFile: (file: File) => void;
  downloadFile: (fileId: string) => Promise<void>;
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

export function useP2P({ roomId, initialFile, encryptionKey }: UseP2POptions): UseP2PResult {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [peers, setPeers] = useState<PeerStatus[]>([]);
  const [files, setFiles] = useState<Record<string, FileTransferState>>({});
  const [error, setError] = useState<string | null>(null);

  const addFileRef = useRef<(f: File) => void>(() => {});
  const initialFileAddedRef = useRef(false);

  const aesKeyRef = useRef<CryptoKey | null>(null);
  const peersRef = useRef<Map<string, PeerEntry>>(new Map());
  
  const filesRef = useRef<Map<string, File>>(new Map());
  const fileStatesRef = useRef<Map<string, FileTransferState>>(new Map());
  const chunkStoresRef = useRef<Map<string, ChunkStore>>(new Map());
  const chunkStorePromisesRef = useRef<Map<string, Promise<ChunkStore>>>(new Map());
  const myChunksRef = useRef<Map<string, Set<number>>>(new Map());
  const sentChunksRef = useRef<Map<string, Set<number>>>(new Map());
  const inFlightRef = useRef<Map<string, Map<number, { peerId: string; at: number }>>>(new Map());
  const pendingHaveRef = useRef<Map<string, Set<number>>>(new Map());
  const bytesWindowRef = useRef<Map<string, { time: number; bytes: number }[]>>(new Map());
  
  const lastHaveBroadcastRef = useRef(0);
  const wasConnectedRef = useRef(false);

  const downloadFileRef = useRef(async (fileId: string) => {
    const state = fileStatesRef.current.get(fileId);
    const store = chunkStoresRef.current.get(fileId);
    if (!state || !store) return;
    try {
      const { downloadBlob } = await import("@/lib/storage");
      const blob = await store.getBlob(state.meta.mime);
      downloadBlob(blob, state.meta.name);
    } catch (e) {
      console.error("Failed to download file", e);
      toast.error("Failed to download the file.");
    }
  });

  useEffect(() => {
    if (!encryptionKey) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setError("Missing decryption key in the URL. Use the full share link.");
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStatus("disconnected");
      return;
    }

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setError(null);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatus("connecting");

    let cancelled = false;
    const socket = getSocket();
    const frameCacheRef = { current: new Map<string, Map<number, Uint8Array>>() };
    const currentPeers = peersRef.current;

    const updatePeersState = () => {
      setPeers(
        [...currentPeers.values()].map((p) => ({ id: p.id, connected: p.connected }))
      );
    };

    const updateFilesState = () => {
      setFiles({ ...Object.fromEntries(fileStatesRef.current.entries()) });
    };

    const recomputeStatus = () => {
      const connected = [...currentPeers.values()].filter((p) => p.connected);
      
      let allComplete = true;
      let hasAnyFiles = false;
      for (const state of fileStatesRef.current.values()) {
        hasAnyFiles = true;
        if (!state.isComplete) allComplete = false;
      }

      if (hasAnyFiles && allComplete) {
        setStatus("connected");
      } else if (connected.length === 0) {
        setStatus(currentPeers.size === 0 && wasConnectedRef.current === false ? "connecting" : "disconnected");
      } else if (connected.length >= 2) {
        setStatus("swarm");
        wasConnectedRef.current = true;
      } else if (!hasAnyFiles) {
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
        // Channel not open yet or already closed
      }
    };

    addFileRef.current = (f: File) => {
      const fileId = uuidv4();
      const totalChunks = Math.max(1, Math.ceil(f.size / CHUNK_SIZE));
      const meta: FileMeta = {
        id: fileId,
        name: f.name,
        size: f.size,
        mime: f.type || "application/octet-stream",
        chunkSize: CHUNK_SIZE,
        totalChunks,
      };

      filesRef.current.set(fileId, f);
      
      const newState: FileTransferState = {
        meta,
        progress: 0,
        speedBps: 0,
        etaSeconds: null,
        isPaused: false,
        isComplete: false,
        error: null,
        role: "sender"
      };
      
      fileStatesRef.current.set(fileId, newState);
      myChunksRef.current.set(fileId, fullSet(totalChunks));
      sentChunksRef.current.set(fileId, new Set());
      inFlightRef.current.set(fileId, new Map());
      pendingHaveRef.current.set(fileId, new Set());
      bytesWindowRef.current.set(fileId, []);
      
      updateFilesState();
      
      for (const entry of currentPeers.values()) {
        if (entry.connected) {
          sendControl(entry, { type: "file-meta", meta });
          sendControl(entry, { type: "have-chunks", fileId, indices: [...fullSet(totalChunks)] });
        }
      }
      recomputeStatus();
    };

    const flushHaveChunks = (force: boolean) => {
      const now = performance.now();
      if (!force && now - lastHaveBroadcastRef.current < HAVE_CHUNKS_THROTTLE_MS) return;
      
      let sentAny = false;
      for (const [fileId, pending] of pendingHaveRef.current.entries()) {
        if (pending.size === 0) continue;
        const indices = [...pending];
        pending.clear();
        sentAny = true;
        for (const entry of currentPeers.values()) {
          if (entry.connected) {
            sendControl(entry, { type: "have-chunks", fileId, indices });
          }
        }
      }
      if (sentAny) {
        lastHaveBroadcastRef.current = now;
      }
    };

    const scheduleRequests = () => {
      const now = performance.now();
      const connectedPeers = [...currentPeers.values()].filter((p) => p.connected);
      let updated = false;

      for (const [fileId, state] of fileStatesRef.current.entries()) {
        if (state.role !== "receiver") continue;
        const meta = state.meta;
        const inFlight = inFlightRef.current.get(fileId)!;
        const myChunks = myChunksRef.current.get(fileId)!;
        
        for (const [index, info] of inFlight) {
          if (now - info.at > IN_FLIGHT_TIMEOUT_MS) inFlight.delete(index);
        }

        if (connectedPeers.length === 0) {
          if (myChunks.size < meta.totalChunks && !state.isComplete) {
            if (!state.isPaused) {
              state.isPaused = true;
              updated = true;
            }
          }
          continue;
        }

        if (state.isPaused) {
          state.isPaused = false;
          updated = true;
        }

        for (const entry of connectedPeers) {
          let inFlightForPeer = 0;
          for (const info of inFlight.values()) {
            if (info.peerId === entry.id) inFlightForPeer++;
          }
          let slots = Math.min(MAX_IN_FLIGHT_PER_PEER - inFlightForPeer, REQUEST_BATCH_SIZE);
          if (slots <= 0) continue;

          const batch: number[] = [];
          const peerChunks = entry.chunksAvailable.get(fileId);
          if (!peerChunks) continue;
          
          for (let i = 0; i < meta.totalChunks && slots > 0; i++) {
            if (myChunks.has(i) || inFlight.has(i)) continue;
            if (!peerChunks.has(i)) continue;
            batch.push(i);
            inFlight.set(i, { peerId: entry.id, at: now });
            slots--;
          }
          if (batch.length > 0) {
            sendControl(entry, { type: "request-chunks", fileId, indices: batch });
          }
        }
      }
      
      if (updated) updateFilesState();
    };

    const completeTransfer = async (fileId: string) => {
      const state = fileStatesRef.current.get(fileId);
      if (!state || state.isComplete) return;
      
      state.isComplete = true;
      state.progress = 100;
      state.etaSeconds = 0;
      state.isPaused = false;
      updateFilesState();

      try {
        const store = chunkStoresRef.current.get(fileId);
        if (store) {
          // just close the stream and make sure it's ready
          await store.getBlob(state.meta.mime);
          toast.success(`"${state.meta.name}" received successfully.`);
        }
      } catch (e) {
        console.error("Failed to finish receiving", e);
      }

      for (const entry of currentPeers.values()) {
        if (entry.connected) {
          sendControl(entry, { type: "transfer-complete", fileId });
        }
      }
      recomputeStatus();
    };

    const ensureChunkStore = (meta: FileMeta) => {
      let promise = chunkStorePromisesRef.current.get(meta.id);
      if (promise) return promise;
      
      promise = ChunkStore.create({
        fileId: meta.id,
        chunkSize: meta.chunkSize,
        totalChunks: meta.totalChunks,
      }).then((store) => {
        chunkStoresRef.current.set(meta.id, store);
        return store;
      });
      chunkStorePromisesRef.current.set(meta.id, promise);
      return promise;
    };

    const serveChunkRequest = async (entry: PeerEntry, fileId: string, indices: number[]) => {
      const state = fileStatesRef.current.get(fileId);
      const key = aesKeyRef.current;
      if (!state || !key) return;
      const meta = state.meta;

      for (const index of indices) {
        if (state.role === "sender") {
          const file = filesRef.current.get(fileId);
          if (!file) continue;
          const start = index * meta.chunkSize;
          const end = Math.min(start + meta.chunkSize, meta.size);
          try {
            const buf = await file.slice(start, end).arrayBuffer();
            const hash = await sha256Bytes(buf);
            const { iv, ciphertext } = await encryptChunk(key, buf);
            const frame = encodeChunkFrame(fileId, index, iv, hash, ciphertext);
            entry.peer.send(frame);
            const sent = sentChunksRef.current.get(fileId)!;
            if (!sent.has(index)) sent.add(index);
          } catch (e) {
            console.error("Failed to read/encrypt chunk", index, e);
          }
        } else {
          const fileCache = frameCacheRef.current.get(fileId);
          if (!fileCache) continue;
          const cached = fileCache.get(index);
          if (cached) {
            try {
              entry.peer.send(cached);
            } catch {
              // ignore
            }
          }
        }
      }
    };

    const handleControlMessage = (entry: PeerEntry, msg: ControlMessage) => {
      switch (msg.type) {
        case "file-meta": {
          if (!fileStatesRef.current.has(msg.meta.id)) {
            const newState: FileTransferState = {
              meta: msg.meta,
              progress: 0,
              speedBps: 0,
              etaSeconds: null,
              isPaused: false,
              isComplete: false,
              error: null,
              role: "receiver"
            };
            fileStatesRef.current.set(msg.meta.id, newState);
            myChunksRef.current.set(msg.meta.id, new Set());
            inFlightRef.current.set(msg.meta.id, new Map());
            pendingHaveRef.current.set(msg.meta.id, new Set());
            bytesWindowRef.current.set(msg.meta.id, []);
            ensureChunkStore(msg.meta);
            updateFilesState();
          }
          recomputeStatus();
          scheduleRequests();
          break;
        }
        case "have-chunks": {
          let peerChunks = entry.chunksAvailable.get(msg.fileId);
          if (!peerChunks) {
            peerChunks = new Set();
            entry.chunksAvailable.set(msg.fileId, peerChunks);
          }
          for (const idx of msg.indices) peerChunks.add(idx);
          scheduleRequests();
          break;
        }
        case "request-chunks": {
          void serveChunkRequest(entry, msg.fileId, msg.indices);
          break;
        }
        case "transfer-complete": {
          // Informational only
          break;
        }
        default:
          break;
      }
    };

    const handleChunkFrame = async (entry: PeerEntry, frame: ChunkFrame, raw: Uint8Array) => {
      const { fileId, index, iv, hash: frameHash, ciphertext } = frame;
      const state = fileStatesRef.current.get(fileId);
      const key = aesKeyRef.current;
      if (!state || !key || state.role !== "receiver") return;
      
      const inFlight = inFlightRef.current.get(fileId)!;
      const myChunks = myChunksRef.current.get(fileId)!;
      
      if (myChunks.has(index)) {
        inFlight.delete(index);
        return;
      }

      try {
        const plaintext = await decryptChunk(key, iv, ciphertext);
        const hash = await sha256Bytes(plaintext);
        if (!bytesEqual(hash, frameHash)) {
          inFlight.delete(index);
          return;
        }

        const store = await ensureChunkStore(state.meta);
        await store.writeChunk(index, plaintext);

        let fileCache = frameCacheRef.current.get(fileId);
        if (!fileCache) {
          fileCache = new Map();
          frameCacheRef.current.set(fileId, fileCache);
        }
        fileCache.set(index, raw.slice());
        
        myChunks.add(index);
        pendingHaveRef.current.get(fileId)!.add(index);
        inFlight.delete(index);
        bytesWindowRef.current.get(fileId)!.push({ time: performance.now(), bytes: plaintext.byteLength });

        flushHaveChunks(false);

        if (myChunks.size === state.meta.totalChunks && !state.isComplete) {
          await completeTransfer(fileId);
        }
      } catch (e) {
        console.error("Chunk decode error", e);
        inFlight.delete(index);
      }
    };

    const createPeerEntry = (id: string, initiator: boolean): PeerEntry => {
      const existing = currentPeers.get(id);
      if (existing) return existing;

      const peer = new SimplePeer({
        initiator,
        trickle: true,
        config: { iceServers: ICE_SERVERS },
      });

      const entry: PeerEntry = { id, peer, connected: false, chunksAvailable: new Map() };
      currentPeers.set(id, entry);

      peer.on("signal", (signal) => {
        socket.emit("signal", { to: id, signal });
      });

      peer.on("connect", () => {
        entry.connected = true;
        updatePeersState();

        for (const [fileId, state] of fileStatesRef.current.entries()) {
          sendControl(entry, { type: "file-meta", meta: state.meta });
          
          const myChunks = myChunksRef.current.get(fileId);
          if (myChunks && myChunks.size > 0) {
            sendControl(entry, {
              type: "have-chunks",
              fileId,
              indices: [...myChunks],
            });
          }
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

        let pausedAny = false;
        for (const [fileId, state] of fileStatesRef.current.entries()) {
          const inFlight = inFlightRef.current.get(fileId)!;
          for (const [index, info] of inFlight) {
            if (info.peerId === id) inFlight.delete(index);
          }
          if (!state.isComplete && state.role === "receiver") {
            pausedAny = true;
          }
        }

        if (pausedAny) {
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
      const entry = currentPeers.get(id);
      if (!entry) return;
      entry.connected = false;
      try {
        entry.peer.destroy();
      } catch {
        // ignore
      }
      currentPeers.delete(id);

      let pausedAny = false;
      for (const [fileId, state] of fileStatesRef.current.entries()) {
        const inFlight = inFlightRef.current.get(fileId)!;
        for (const [index, info] of inFlight) {
          if (info.peerId === id) inFlight.delete(index);
        }
        if (!state.isComplete && state.role === "receiver") {
          pausedAny = true;
        }
      }

      updatePeersState();
      if (pausedAny) {
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

      if (initialFile && !initialFileAddedRef.current) {
        initialFileAddedRef.current = true;
        addFileRef.current(initialFile);
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
      let updated = false;
      
      for (const [fileId, state] of fileStatesRef.current.entries()) {
        const meta = state.meta;
        let windowArr = bytesWindowRef.current.get(fileId)!;
        
        windowArr = windowArr.filter((e) => now - e.time < SPEED_WINDOW_MS);
        bytesWindowRef.current.set(fileId, windowArr);

        const windowBytes = windowArr.reduce((s, e) => s + e.bytes, 0);
        const span = windowArr.length
          ? Math.max((now - windowArr[0].time) / 1000, 0.25)
          : 1;
        state.speedBps = windowBytes / span;

        if (state.role === "receiver") {
          const done = myChunksRef.current.get(fileId)!.size;
          state.progress = (done / meta.totalChunks) * 100;
          if (!state.isComplete) {
            const remaining = meta.size - done * meta.chunkSize;
            state.etaSeconds = state.speedBps > 1024 ? Math.max(remaining, 0) / state.speedBps : null;
          }
        } else if (state.role === "sender") {
          const sent = sentChunksRef.current.get(fileId)!.size;
          state.progress = (sent / meta.totalChunks) * 100;
        }
        updated = true;
      }

      if (updated) updateFilesState();
      flushHaveChunks(true);
      scheduleRequests();
    };

    const interval = setInterval(tick, TICK_INTERVAL_MS);

    const currentChunkStores = chunkStoresRef.current;

    return () => {
      cancelled = true;
      clearInterval(interval);
      socket.off("room-peers", onRoomPeers);
      socket.off("peer-joined", onPeerJoined);
      socket.off("signal", onSignal);
      socket.off("peer-left", onPeerLeft);
      socket.off("connect", joinRoom);
      for (const entry of currentPeers.values()) {
        try {
          entry.peer.destroy();
        } catch {
          // ignore
        }
      }
      currentPeers.clear();
      
      // cleanup stores
      for (const store of currentChunkStores.values()) {
        store.cleanup().catch(() => {});
      }
      currentChunkStores.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, encryptionKey]); // Intentionally omitting initialFile so it only runs once

  return {
    status,
    peers,
    files,
    addFile: (f: File) => addFileRef.current(f),
    downloadFile: (fileId: string) => downloadFileRef.current(fileId),
    error,
  };
}
