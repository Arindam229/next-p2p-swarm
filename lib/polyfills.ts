// simple-peer's dependency chain (readable-stream, buffer, randombytes)
// expects Node's `Buffer` and `process` globals to exist. Next.js's
// browser bundle doesn't provide these by default, so we install them
// once on the client before any WebRTC code runs.
import { Buffer } from "buffer";
import process from "process";

if (typeof window !== "undefined") {
  const globalAny = window as unknown as { Buffer?: unknown; process?: unknown };
  if (!globalAny.Buffer) globalAny.Buffer = Buffer;
  if (!globalAny.process) globalAny.process = process;
}
