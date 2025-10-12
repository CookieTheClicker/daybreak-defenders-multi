
import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Paths
const CLIENT_DIR = path.normalize(path.join(__dirname, "..")); // serve project root (index.html, assets, src, etc.)

// App
const app = express();
app.use(cors());
app.use(express.static(CLIENT_DIR));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET","POST"] }
});

// In-memory state of peers: id -> { x, y, dir, hp, ... }
const peers = Object.create(null);

io.on("connection", (socket) => {
  console.log("client connected", socket.id);

  // Send full snapshot to the new client (excluding itself handled client-side)
  socket.emit("peers", peers);

  socket.on("hello", (info) => {
    // initialize entry
    peers[socket.id] = { name: info?.name || "Player", x: 0, y: 0, dir: 0, hp: 100, ts: Date.now() };
    // broadcast join (optional)
    socket.broadcast.emit("peerUpdate", { id: socket.id, state: peers[socket.id] });
  });

  socket.on("state", (state) => {
    if (typeof state !== "object" || state == null) return;
    peers[socket.id] = { ...(peers[socket.id] || {}), ...state, ts: Date.now() };
    socket.broadcast.emit("peerUpdate", { id: socket.id, state: peers[socket.id] });
  });

  socket.on("event", ({ type, payload }) => {
    if (typeof type !== "string") return;
    // fan out to everyone else
    socket.broadcast.emit("event", { type, payload, from: socket.id });
  });

  socket.on("disconnect", () => {
    console.log("client disconnected", socket.id);
    delete peers[socket.id];
    socket.broadcast.emit("peerLeave", { id: socket.id });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Daybreak Defenders server running: http://localhost:${PORT}`);
  console.log(`Serving static from: ${CLIENT_DIR}`);
});
