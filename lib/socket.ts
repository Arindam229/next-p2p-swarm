import { io, Socket } from "socket.io-client";

let socket: Socket | null = null;

/**
 * Lazily creates a single socket.io connection to our own signaling server
 * (mounted on the same HTTP server as Next.js by server.js).
 */
export function getSocket(): Socket {
  if (!socket) {
    socket = io({
      path: "/socket.io",
      transports: ["websocket", "polling"],
    });
  }
  return socket;
}
