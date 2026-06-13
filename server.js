const { createServer } = require("http");
const next = require("next");
const { Server } = require("socket.io");

const port = parseInt(process.env.PORT || "3000", 10);
const dev = process.env.NODE_ENV !== "production";

const app = next({ dev });
const handle = app.getRequestHandler();

// Pure in-memory signaling state. The server only ever sees room IDs and
// socket IDs - it never touches file data or encryption keys.
const rooms = new Map(); // roomId -> Set<socketId>

app.prepare().then(() => {
  const httpServer = createServer((req, res) => {
    handle(req, res);
  });

  const io = new Server(httpServer, {
    cors: { origin: "*" },
  });

  io.on("connection", (socket) => {
    socket.on("join-room", (roomId) => {
      if (typeof roomId !== "string" || !roomId) return;

      socket.join(roomId);
      socket.data.roomId = roomId;

      const peers = rooms.get(roomId) ?? new Set();
      const existingPeers = Array.from(peers);
      peers.add(socket.id);
      rooms.set(roomId, peers);

      // The newly joined peer learns who is already in the room. It will
      // wait for those peers to initiate a WebRTC offer.
      socket.emit("room-peers", existingPeers);

      // Existing peers learn about the new arrival and become the
      // initiators of a fresh mesh connection to them.
      socket.to(roomId).emit("peer-joined", socket.id);
    });

    // Relay WebRTC SDP offers/answers and ICE candidates verbatim. The
    // server cannot read or modify the payload's meaning - it's opaque.
    socket.on("signal", ({ to, signal }) => {
      if (!to || !signal) return;
      io.to(to).emit("signal", { from: socket.id, signal });
    });

    socket.on("disconnect", () => {
      const roomId = socket.data.roomId;
      if (!roomId) return;

      const peers = rooms.get(roomId);
      if (peers) {
        peers.delete(socket.id);
        if (peers.size === 0) {
          rooms.delete(roomId);
        }
      }

      socket.to(roomId).emit("peer-left", socket.id);
    });
  });

  httpServer
    .once("error", (err) => {
      console.error(err);
      process.exit(1);
    })
    .listen(port, () => {
      console.log(
        `> P2P signaling server ready on http://localhost:${port} (${
          dev ? "development" : "production"
        })`
      );
    });
});
