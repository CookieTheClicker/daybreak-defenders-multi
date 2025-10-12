// Enhanced multiplayer client for Daybreak Defenders.
// Handles lobby creation/joining, deterministic seeding, and peer state mirroring.

const DEFAULT_SEND_HZ = 15;

function noop() {}

function asString(value, fallback = "") {
    if (value === undefined || value === null) return fallback;
    return String(value);
}

export default class Multiplayer {
    constructor(url = window.location.origin) {
        this.url = url;
        this.socket = null;
        this.id = null;

        this._getLocalState = null;
        this._peers = {};
        this._peersCb = noop;
        this._eventHandlers = new Map();
        this._sendHz = DEFAULT_SEND_HZ;
        this._tickInterval = null;

        this.playerName = localStorage.getItem("dd_name") || "Player";

        this.lobbyId = null;
        this.hostId = null;
        this.seed = null;
        this.lobbyStarted = false;
        this._lastLobbySnapshot = null;

        this._lobbyUpdateHandlers = new Set();
        this._lobbyStartedHandlers = new Set();
        this._lobbySeedHandlers = new Set();
        this._lobbyLeftHandlers = new Set();
        this._lobbyErrorHandlers = new Set();
    }

    connect() {
        if (typeof io === "undefined") {
            console.error("[Multiplayer] Socket.IO client not found. Include <script src=\"/socket.io/socket.io.js\"></script>.");
            return;
        }
        if (this.socket) {
            return;
        }
        this.socket = io(this.url, { transports: ["websocket"], autoConnect: true });
        this._wire();
    }

    _wire() {
        if (!this.socket) return;

        this.socket.on("connect", () => {
            this.id = this.socket.id;
            console.log("[Multiplayer] connected", this.id);
            this._sendHello();
            this._startSendLoop();
        });

        this.socket.on("connected", ({ id } = {}) => {
            if (id) {
                this.id = id;
            }
        });

        this.socket.on("disconnect", (reason) => {
            console.warn("[Multiplayer] disconnected:", reason);
            this._stopSendLoop();
            this._peers = {};
            this._peersCb(this._peers);
            this._emitTo(this._lobbyUpdateHandlers, {
                lobbyId: this.lobbyId,
                hostId: this.hostId,
                seed: this.seed,
                started: this.lobbyStarted,
                members: []
            });
        });

        this.socket.on("peers", (peers = {}) => {
            if (this.id && peers[this.id]) {
                delete peers[this.id];
            }
            this._peers = peers || {};
            this._peersCb(this._peers);
        });

        this.socket.on("peerUpdate", ({ id, state }) => {
            if (!id || id === this.id) return;
            this._peers[id] = { ...(this._peers[id] || {}), ...state, _ts: Date.now() };
            this._peersCb(this._peers);
        });

        this.socket.on("peerLeave", ({ id }) => {
            if (!id) return;
            delete this._peers[id];
            this._peersCb(this._peers);
        });

        this.socket.on("event", ({ type, payload, from }) => {
            const handlers = this._eventHandlers.get(type) || [];
            for (const handler of handlers) {
                try {
                    handler({ payload, from });
                } catch (error) {
                    console.error("[Multiplayer] event handler error", error);
                }
            }
        });

        this.socket.on("lobbyCreated", (data) => {
            this._applyLobbySnapshot({ ...data, members: [] });
        });

        this.socket.on("lobbyJoined", (data) => {
            this._applyLobbySnapshot(data);
        });

        this.socket.on("lobbyUpdate", (data) => {
            this._applyLobbySnapshot({ ...this._lastLobbySnapshot, ...data });
        });

        this.socket.on("lobbyStarted", (data) => {
            if (data?.seed !== undefined) {
                this.seed = data.seed;
            }
            if (data?.hostId) {
                this.hostId = data.hostId;
            }
            if (data?.lobbyId) {
                this.lobbyId = data.lobbyId;
            }
            this.lobbyStarted = true;
            this._emitTo(this._lobbyStartedHandlers, { ...data, seed: this.seed, lobbyId: this.lobbyId });
        });

        this.socket.on("lobbySeed", (data) => {
            if (!data) return;
            if (data.seed !== undefined) {
                this.seed = data.seed;
            }
            if (data.lobbyId) {
                this.lobbyId = data.lobbyId;
            }
            this._emitTo(this._lobbySeedHandlers, { lobbyId: this.lobbyId, seed: this.seed });
        });

        this.socket.on("lobbyLeft", (data) => {
            if (!data || (this.lobbyId && data.lobbyId !== this.lobbyId)) {
                return;
            }
            this._handleLobbyLeft(data.reason || "left");
        });

        this.socket.on("lobbyError", (data) => {
            this._emitTo(this._lobbyErrorHandlers, data || { error: "unknown" });
        });
    }

    _handleLobbyLeft(reason) {
        const payload = {
            lobbyId: this.lobbyId,
            reason: reason || "left"
        };
        this.lobbyId = null;
        this.hostId = null;
        this.seed = null;
        this.lobbyStarted = false;
        this._lastLobbySnapshot = null;
        this._peers = {};
        this._peersCb(this._peers);
        this._emitTo(this._lobbyLeftHandlers, payload);
        this._emitTo(this._lobbyUpdateHandlers, {
            lobbyId: null,
            hostId: null,
            seed: null,
            started: false,
            members: []
        });
    }

    _applyLobbySnapshot(snapshot = {}) {
        if (!snapshot) return;
        if (snapshot.lobbyId !== undefined) {
            this.lobbyId = snapshot.lobbyId;
        }
        if (snapshot.hostId !== undefined) {
            this.hostId = snapshot.hostId;
        }
        if (snapshot.seed !== undefined) {
            this.seed = snapshot.seed;
        }
        if (snapshot.started !== undefined) {
            this.lobbyStarted = Boolean(snapshot.started);
        }
        if (snapshot.members === undefined && this._lastLobbySnapshot?.members) {
            snapshot.members = this._lastLobbySnapshot.members;
        }
        this._lastLobbySnapshot = snapshot;
        this._emitTo(this._lobbyUpdateHandlers, {
            lobbyId: this.lobbyId,
            hostId: this.hostId,
            seed: this.seed,
            started: this.lobbyStarted,
            members: snapshot.members || []
        });
    }

    _emitTo(handlers, payload) {
        for (const handler of handlers) {
            try {
                handler(payload);
            } catch (error) {
                console.error("[Multiplayer] listener error", error);
            }
        }
    }

    _startSendLoop() {
        if (this._tickInterval) return;
        this._tickInterval = setInterval(() => {
            if (!this._getLocalState || !this.socket || this.socket.disconnected) {
                return;
            }
            const state = this._getLocalState();
            if (state && typeof state.x === "number" && typeof state.y === "number") {
                this.socket.emit("state", state);
            }
        }, 1000 / this._sendHz);
    }

    _stopSendLoop() {
        if (this._tickInterval) {
            clearInterval(this._tickInterval);
            this._tickInterval = null;
        }
    }

    _sendHello() {
        if (!this.socket) return;
        this.socket.emit("hello", {
            name: this.playerName,
            ts: Date.now()
        });
    }

    setLocalStateProvider(fn) {
        this._getLocalState = fn;
    }

    onPeers(cb) {
        this._peersCb = typeof cb === "function" ? cb : noop;
        this._peersCb(this._peers);
    }

    emit(type, payload) {
        if (!this.socket) return;
        this.socket.emit("event", { type, payload });
    }

    onEvent(type, handler) {
        if (!type || typeof handler !== "function") return;
        const handlers = this._eventHandlers.get(type) || [];
        handlers.push(handler);
        this._eventHandlers.set(type, handlers);
    }

    offEvent(type, handler) {
        const handlers = this._eventHandlers.get(type);
        if (!handlers) return;
        const next = handlers.filter((fn) => fn !== handler);
        this._eventHandlers.set(type, next);
    }

    onLobbyUpdate(handler) {
        if (typeof handler !== "function") return noop;
        this._lobbyUpdateHandlers.add(handler);
        if (this._lastLobbySnapshot) {
            handler({ ...this._lastLobbySnapshot });
        } else {
            handler({
                lobbyId: this.lobbyId,
                hostId: this.hostId,
                seed: this.seed,
                started: this.lobbyStarted,
                members: []
            });
        }
        return () => this._lobbyUpdateHandlers.delete(handler);
    }

    onLobbyStarted(handler) {
        if (typeof handler !== "function") return noop;
        this._lobbyStartedHandlers.add(handler);
        return () => this._lobbyStartedHandlers.delete(handler);
    }

    onLobbySeed(handler) {
        if (typeof handler !== "function") return noop;
        this._lobbySeedHandlers.add(handler);
        if (this.seed !== null && this.lobbyId) {
            handler({ lobbyId: this.lobbyId, seed: this.seed });
        }
        return () => this._lobbySeedHandlers.delete(handler);
    }

    onLobbyLeft(handler) {
        if (typeof handler !== "function") return noop;
        this._lobbyLeftHandlers.add(handler);
        return () => this._lobbyLeftHandlers.delete(handler);
    }

    onLobbyError(handler) {
        if (typeof handler !== "function") return noop;
        this._lobbyErrorHandlers.add(handler);
        return () => this._lobbyErrorHandlers.delete(handler);
    }

    createLobby(options = {}) {
        return new Promise((resolve, reject) => {
            if (!this.socket) {
                reject(new Error("Socket not connected"));
                return;
            }
            const payload = {
                lobbyName: options.lobbyName ? String(options.lobbyName).slice(0, 48) : undefined,
                playerName: options.playerName ? String(options.playerName).slice(0, 32) : this.playerName,
                seed: options.seed
            };
            this.playerName = payload.playerName || this.playerName;
            this.socket.emit("createLobby", payload, (response) => {
                if (response?.ok) {
                    this._sendHello();
                    resolve(response);
                } else {
                    reject(new Error(response?.error || "Failed to create lobby"));
                }
            });
        });
    }

    joinLobby(lobbyId, options = {}) {
        return new Promise((resolve, reject) => {
            if (!this.socket) {
                reject(new Error("Socket not connected"));
                return;
            }
            const payload = {
                lobbyId: asString(lobbyId, "").toUpperCase(),
                playerName: options.playerName ? String(options.playerName).slice(0, 32) : this.playerName
            };
            if (!payload.lobbyId) {
                reject(new Error("Lobby code required"));
                return;
            }
            this.playerName = payload.playerName || this.playerName;
            this.socket.emit("joinLobby", payload, (response) => {
                if (response?.ok) {
                    this._sendHello();
                    resolve(response);
                } else {
                    reject(new Error(response?.error || "Failed to join lobby"));
                }
            });
        });
    }

    leaveLobby() {
        if (!this.socket || !this.lobbyId) return;
        this.socket.emit("leaveLobby");
    }

    startLobbyGame() {
        if (!this.socket || !this.isHost()) return;
        this.socket.emit("startLobbyGame");
    }

    setLobbySeed(seed) {
        if (!this.socket || !this.isHost()) return;
        const numeric = Number(seed);
        if (!Number.isFinite(numeric)) return;
        this.socket.emit("setLobbySeed", numeric >>> 0);
    }

    isHost() {
        return Boolean(this.id && this.hostId && this.id === this.hostId);
    }
}

