import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLIENT_DIR = path.normalize(path.join(__dirname, ".."));

const app = express();
app.use(cors());
app.use(express.static(CLIENT_DIR));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const LOBBY_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LOBBY_CODE_LENGTH = 5;
const lobbies = new Map();

function normalizeLobbyId(id) {
  return String(id ?? "").trim().toUpperCase();
}

function generateLobbyCode() {
  let code = "";
  do {
    code = Array.from({ length: LOBBY_CODE_LENGTH }, () => {
      const index = Math.floor(Math.random() * LOBBY_CODE_CHARS.length);
      return LOBBY_CODE_CHARS[index];
    }).join("");
  } while (lobbies.has(code));
  return code;
}

function generateSeed() {
  return crypto.randomBytes(4).readUInt32BE(0);
}

function ensurePeerEntry(lobby, id) {
  if (!lobby.peers[id]) {
    lobby.peers[id] = { name: "Player", state: {}, ts: Date.now() };
  }
  return lobby.peers[id];
}

function serializePeers(lobby, excludeId) {
  const result = {};
  for (const [id, peer] of Object.entries(lobby.peers)) {
    if (id === excludeId) continue;
    result[id] = { ...(peer.state || {}), name: peer.name, ts: peer.ts };
  }
  return result;
}

function broadcastLobbyState(lobby) {
  const payload = {
    lobbyId: lobby.id,
    hostId: lobby.hostId,
    seed: lobby.seed,
    started: lobby.started,
    members: Object.entries(lobby.peers).map(([id, peer]) => ({
      id,
      name: peer.name ?? "Player",
      ts: peer.ts
    }))
  };
  io.to(lobby.id).emit("lobbyUpdate", payload);
}

function leaveLobby(socket, reason = "leave") {
  const lobbyId = socket.data?.lobbyId;
  if (!lobbyId) return;
  const lobby = lobbies.get(lobbyId);
  if (!lobby) {
    socket.data.lobbyId = null;
    return;
  }

  socket.leave(lobby.id);
  delete lobby.peers[socket.id];
  socket.data.lobbyId = null;

  socket.emit("lobbyLeft", { lobbyId, reason });
  socket.to(lobby.id).emit("peerLeave", { id: socket.id });

  if (lobby.hostId === socket.id) {
    const remaining = Object.keys(lobby.peers);
    lobby.hostId = remaining[0] ?? null;
  }

  if (!Object.keys(lobby.peers).length) {
    lobbies.delete(lobby.id);
  } else {
    broadcastLobbyState(lobby);
  }
}

function joinLobby(socket, lobby, name) {
  if (socket.data?.lobbyId === lobby.id) {
    return lobby;
  }
  if (socket.data?.lobbyId) {
    leaveLobby(socket, "switch");
  }

  socket.join(lobby.id);
  socket.data = socket.data || {};
  socket.data.lobbyId = lobby.id;

  const peer = ensurePeerEntry(lobby, socket.id);
  if (name) {
    peer.name = name;
  }
  peer.ts = Date.now();

  socket.emit("lobbyJoined", {
    lobbyId: lobby.id,
    seed: lobby.seed,
    hostId: lobby.hostId,
    started: lobby.started
  });
  socket.emit("peers", serializePeers(lobby, socket.id));
  broadcastLobbyState(lobby);
  return lobby;
}

function getLobbyForSocket(socket) {
  const lobbyId = socket.data?.lobbyId;
  if (!lobbyId) return null;
  return lobbies.get(lobbyId) ?? null;
}

io.on("connection", (socket) => {
  console.log("client connected", socket.id);
  socket.data = socket.data || {};
  socket.data.lobbyId = null;

  socket.emit("connected", { id: socket.id });

  socket.on("createLobby", (options = {}, ack) => {
    const name = options?.playerName ? String(options.playerName).slice(0, 32) : null;
    const lobbyName = options?.lobbyName ? String(options.lobbyName).slice(0, 48) : null;
    const seed = Number.isFinite(options?.seed) ? (options.seed >>> 0) : generateSeed();
    const lobbyId = generateLobbyCode();

    const lobby = {
      id: lobbyId,
      name: lobbyName || `Lobby ${lobbyId}`,
      seed,
      hostId: socket.id,
      started: false,
      createdAt: Date.now(),
      peers: Object.create(null)
    };
    lobbies.set(lobbyId, lobby);

    ensurePeerEntry(lobby, socket.id).name = name || "Player";
    joinLobby(socket, lobby, name || "Player");

    if (typeof ack === "function") {
      ack({ ok: true, lobbyId, seed });
    }
    socket.emit("lobbyCreated", { lobbyId, seed, hostId: lobby.hostId });
  });

  socket.on("joinLobby", (payload = {}, ack) => {
    const lobbyId = normalizeLobbyId(payload?.lobbyId);
    const name = payload?.playerName ? String(payload.playerName).slice(0, 32) : null;
    if (!lobbies.has(lobbyId)) {
      if (typeof ack === "function") {
        ack({ ok: false, error: "not-found" });
      } else {
        socket.emit("lobbyError", { error: "not-found", lobbyId });
      }
      return;
    }

    const lobby = lobbies.get(lobbyId);
    ensurePeerEntry(lobby, socket.id).name = name || lobby.peers[socket.id]?.name || "Player";
    joinLobby(socket, lobby, name || lobby.peers[socket.id]?.name || "Player");

    if (typeof ack === "function") {
      ack({ ok: true, lobbyId, seed: lobby.seed, hostId: lobby.hostId });
    }
  });

  socket.on("leaveLobby", () => {
    leaveLobby(socket, "leave");
  });

  socket.on("hello", (info = {}) => {
    const lobby = getLobbyForSocket(socket);
    if (!lobby) return;
    const peer = ensurePeerEntry(lobby, socket.id);
    if (info?.name) {
      peer.name = String(info.name).slice(0, 32);
    }
    peer.ts = Date.now();
    socket.to(lobby.id).emit("peerUpdate", { id: socket.id, state: { ...(peer.state || {}), name: peer.name } });
    broadcastLobbyState(lobby);
  });

  socket.on("state", (state) => {
    if (typeof state !== "object" || state == null) return;
    const lobby = getLobbyForSocket(socket);
    if (!lobby) return;
    const peer = ensurePeerEntry(lobby, socket.id);
    peer.state = { ...(peer.state || {}), ...state };
    peer.ts = Date.now();
    socket.to(lobby.id).emit("peerUpdate", { id: socket.id, state: { ...(peer.state || {}), name: peer.name } });
  });

  socket.on("event", ({ type, payload } = {}) => {
    if (typeof type !== "string") return;
    const lobby = getLobbyForSocket(socket);
    if (!lobby) return;
    socket.to(lobby.id).emit("event", { type, payload, from: socket.id });
  });

  socket.on("startLobbyGame", () => {
    const lobby = getLobbyForSocket(socket);
    if (!lobby || lobby.hostId !== socket.id) {
      return;
    }
    lobby.started = true;
    io.to(lobby.id).emit("lobbyStarted", { lobbyId: lobby.id, seed: lobby.seed, hostId: lobby.hostId });
    broadcastLobbyState(lobby);
  });

  socket.on("setLobbySeed", (seed) => {
    const lobby = getLobbyForSocket(socket);
    if (!lobby || lobby.hostId !== socket.id) return;
    if (!Number.isFinite(seed)) return;
    lobby.seed = seed >>> 0;
    io.to(lobby.id).emit("lobbySeed", { lobbyId: lobby.id, seed: lobby.seed });
    broadcastLobbyState(lobby);
  });

  socket.on("disconnect", () => {
    console.log("client disconnected", socket.id);
    leaveLobby(socket, "disconnect");
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Daybreak Defenders server running: http://localhost:${PORT}`);
  console.log(`Serving static from: ${CLIENT_DIR}`);
});

