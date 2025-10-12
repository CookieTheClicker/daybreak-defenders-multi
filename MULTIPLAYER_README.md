
# Daybreak Defenders — Multiplayer Add-On

This adds a **Socket.IO** multiplayer layer to your existing game without forcing a rewrite.

## What you got

- `server/` — Node.js server (Express + Socket.IO) that also serves your static game files.
- `src/multiplayer.js` — Tiny client library with a simple API.
- `src/multiplayer_integration_example.js` — Example of how to wire your game loop.
- `index.html` now loads the Socket.IO client and initializes the multiplayer client (`window.__MP__`).

## How to run locally

1. Open a terminal and go to the **server** folder:
   ```bash
   cd server
   npm install
   npm start
   ```
2. Open the game in your browser: http://localhost:3000  
   Open it in two tabs (or two devices on the same network) to see peers.

## How to integrate with your player loop

Somewhere after you create your player, call:

```js
import { setupMultiplayer } from "./src/multiplayer_integration_example.js";

setupMultiplayer(
  () => ({
    x: player.x,
    y: player.y,
    dir: player.dir,   // facing/radians or degrees
    hp: player.hp,
    anim: player.anim, // optional animation state
    vx: player.vx,     // optional
    vy: player.vy      // optional
  }),
  (peers) => {
    // peers is an object mapping id -> { x, y, dir, hp, anim, ... }
    // Draw / update remote players here.
    // Example:
    // remotePlayers = peers;
  }
);
```

### Sending gameplay events (optional)

You can broadcast custom events (e.g., projectiles, hits, chat):

```js
// Send
window.__MP__.emit("projectile", { x, y, vx, vy, type: "arrow" });

// Receive
window.__MP__.onEvent("projectile", ({ payload, from }) => {
  spawnProjectile(payload, from);
});
```

## Deploying

- On a VPS/VM: `npm ci && npm run start` inside `server/`. Use a reverse proxy (Nginx/Caddy) to expose port 3000 (or change `PORT` env var).
- On Render/Railway/Heroku: point the web service to `server/index.js`. Make sure it serves static files from the project root (already configured).

## Notes

- The server stores peer states in memory. For production, you might add rooms, authentication, and persistence.
- Tick rate is 15 Hz to keep bandwidth low; adjust in `src/multiplayer.js` (`this._sendHz`).

Happy defending!
