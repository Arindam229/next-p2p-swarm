/**
 * Persists incoming, decrypted chunks straight to disk so multi-hundred-MB
 * transfers never have to live entirely in JS heap memory.
 *
 * Primary backend: Origin Private File System (OPFS) via a writable file
 * stream with positional writes, so out-of-order swarm chunks land in the
 * right place. Falls back to IndexedDB (one record per chunk) on browsers
 * without OPFS support.
 */

export interface ChunkStoreOptions {
  fileId: string;
  chunkSize: number;
  totalChunks: number;
}

const DB_NAME = "p2p-swarm-store";
const DB_VERSION = 1;
const STORE_NAME = "chunks";

function opfsSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.storage &&
    typeof navigator.storage.getDirectory === "function"
  );
}

export class ChunkStore {
  private fileId: string;
  private chunkSize: number;
  private totalChunks: number;
  private received = new Set<number>();

  private backend: "opfs" | "indexeddb";
  private opfsHandle: FileSystemFileHandle | null = null;
  private opfsWritable: FileSystemWritableFileStream | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private db: IDBDatabase | null = null;

  private constructor(opts: ChunkStoreOptions, backend: "opfs" | "indexeddb") {
    this.fileId = opts.fileId;
    this.chunkSize = opts.chunkSize;
    this.totalChunks = opts.totalChunks;
    this.backend = backend;
  }

  static async create(opts: ChunkStoreOptions): Promise<ChunkStore> {
    if (opfsSupported()) {
      try {
        const store = new ChunkStore(opts, "opfs");
        const root = await navigator.storage.getDirectory();
        store.opfsHandle = await root.getFileHandle(`p2p-${opts.fileId}.part`, {
          create: true,
        });
        store.opfsWritable = await store.opfsHandle.createWritable({
          keepExistingData: false,
        });
        return store;
      } catch {
        // fall through to IndexedDB
      }
    }

    const store = new ChunkStore(opts, "indexeddb");
    store.db = await openDatabase();
    return store;
  }

  get receivedCount(): number {
    return this.received.size;
  }

  hasChunk(index: number): boolean {
    return this.received.has(index);
  }

  /** Writes a decrypted chunk to its absolute position in the output file. */
  async writeChunk(index: number, data: ArrayBuffer): Promise<void> {
    if (this.received.has(index)) return;

    if (this.backend === "opfs" && this.opfsWritable) {
      const position = index * this.chunkSize;
      this.writeQueue = this.writeQueue.then(() =>
        this.opfsWritable!.write({ type: "write", position, data })
      );
      await this.writeQueue;
    } else if (this.db) {
      await idbPut(this.db, `${this.fileId}:${index}`, data);
    }

    this.received.add(index);
  }

  /** Closes the underlying stream and triggers a browser download of the full file. */
  async finalize(fileName: string, mime: string): Promise<void> {
    let blob: Blob;

    if (this.backend === "opfs" && this.opfsWritable && this.opfsHandle) {
      await this.writeQueue;
      await this.opfsWritable.close();
      blob = await this.opfsHandle.getFile();
    } else if (this.db) {
      const parts: ArrayBuffer[] = [];
      for (let i = 0; i < this.totalChunks; i++) {
        const chunk = await idbGet(this.db, `${this.fileId}:${i}`);
        if (chunk) parts.push(chunk);
      }
      blob = new Blob(parts, { type: mime });
    } else {
      throw new Error("ChunkStore has no active backend");
    }

    downloadBlob(new Blob([blob], { type: mime }), fileName);
    
    // Give the browser's download manager plenty of time to stream the file 
    // from OPFS/memory to the user's Downloads folder before deleting it.
    setTimeout(() => {
      this.cleanup().catch(() => {});
    }, 5 * 60 * 1000);
  }

  /** Removes any temporary storage used during the transfer. */
  async cleanup(): Promise<void> {
    if (this.backend === "opfs") {
      try {
        const root = await navigator.storage.getDirectory();
        await root.removeEntry(`p2p-${this.fileId}.part`);
      } catch {
        // best effort
      }
    } else if (this.db) {
      for (let i = 0; i < this.totalChunks; i++) {
        await idbDelete(this.db, `${this.fileId}:${i}`).catch(() => {});
      }
    }
  }
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000);
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db: IDBDatabase, key: string, value: ArrayBuffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function idbGet(db: IDBDatabase, key: string): Promise<ArrayBuffer | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result as ArrayBuffer | undefined);
    req.onerror = () => reject(req.error);
  });
}

function idbDelete(db: IDBDatabase, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
