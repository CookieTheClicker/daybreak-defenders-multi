
// Lightweight multiplayer client for Daybreak Defenders
// Socket.IO-based; exposes a small API decoupled from the game loop.
// Usage in game code:
//   import Multiplayer from "./multiplayer.js";
//   const mp = new Multiplayer();
//   mp.connect();
//   mp.setLocalStateProvider(() => ({ x, y, dir, hp, anim, vx, vy }));
//   mp.onPeers((peers) => { /* draw other players */ });
//   mp.onEvent("projectile", (data) => { /* spawn remote projectile */ });
//   // To broadcast an event: mp.emit("projectile", payload);

export default class Multiplayer {
  constructor(url = window.location.origin) {
    this.url = url;
    this.socket = null;
    this._getLocalState = null;
    this._peersCb = () => {};
    this._eventHandlers = new Map();
    this._peers = {}; // id -> state
    this._tickInterval = null;
    this._lastSent = 0;
    this._sendHz = 15; // 15 updates/sec is plenty
  }

  connect() {
    // Ensure Socket.IO client is available
    if (typeof io === "undefined") {
      console.error("[Multiplayer] Socket.IO client not found. Make sure <script src=\"/socket.io/socket.io.js\"></script> is included.");
      return;
    }
    this.socket = io(this.url, { transports: ["websocket"], autoConnect: true });
    this._wire();
  }

  _wire() {
    if (!this.socket) return;

    this.socket.on("connect", () => {
      console.log("[Multiplayer] connected", this.socket.id);
      // Immediately send a hello with a display name (optional)
      this.socket.emit("hello", {
        name: localStorage.getItem("dd_name") || "Player",
        ts: Date.now()
      });
      // Start state send loop
      this._startSendLoop();
    });

    this.socket.on("disconnect", (reason) => {
      console.log("[Multiplayer] disconnected:", reason);
      this._stopSendLoop();
      this._peers = {};
      this._peersCb(this._peers);
    });

    this.socket.on("peers", (peers) => {
      // full snapshot from server
      delete peers[this.socket.id];
      this._peers = peers;
      this._peersCb(this._peers);
    });

    this.socket.on("peerUpdate", ({ id, state }) => {
      if (id === this.socket.id) return;
      this._peers[id] = { ...(this._peers[id] || {}), ...state, _ts: Date.now() };
      this._peersCb(this._peers);
    });

    this.socket.on("peerLeave", ({ id }) => {
      delete this._peers[id];
      this._peersCb(this._peers);
    });

    this.socket.on("event", ({ type, payload, from }) => {
      const handlers = this._eventHandlers.get(type) || [];
      for (const h of handlers) h({ payload, from });
    });
  }

  _startSendLoop() {
    if (this._tickInterval) return;
    this._tickInterval = setInterval(() => {
      if (!this._getLocalState || !this.socket || this.socket.disconnected) return;
      const now = Date.now();
      const state = this._getLocalState();
      // Only send if state is valid
      if (state && typeof state.x === "number" && typeof state.y === "number") {
        this.socket.emit("state", state);
      }
      this._lastSent = now;
    }, 1000 / this._sendHz);
  }
  _stopSendLoop() {
    clearInterval(this._tickInterval);
    this._tickInterval = null;
  }

  // Game calls this to supply local state each tick
  setLocalStateProvider(fn) { this._getLocalState = fn; }

  // Subscribe to peers map changes
  onPeers(cb) { this._peersCb = cb; cb(this._peers); }

  // Emit a named gameplay event to everyone
  emit(type, payload) {
    if (!this.socket) return;
    this.socket.emit("event", { type, payload });
  }

  // Listen for a named gameplay event
  onEvent(type, handler) {
    const arr = this._eventHandlers.get(type) || [];
    arr.push(handler);
    this._eventHandlers.set(type, arr);
  }
}
