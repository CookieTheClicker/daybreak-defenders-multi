
// Example: wire your game's player state into multiplayer
// Call setupMultiplayer(getState, onPeers) after your game creates the player.

export function setupMultiplayer(getLocalState, onPeersUpdate) {
  const mp = window.__MP__;
  if (!mp) {
    console.warn("Multiplayer not initialized");
    return;
  }
  mp.setLocalStateProvider(() => {
    // Expect getLocalState to return an object like:
    // { x, y, dir, hp, anim, vx, vy }
    return getLocalState();
  });
  mp.onPeers((peers) => {
    // 'peers' is an object: id -> state
    // You can iterate and draw remote players
    onPeersUpdate(peers);
  });

  // Optional: events example
  // mp.onEvent("projectile", ({ payload, from }) => spawnProjectile(payload, from));
  // To emit: mp.emit("projectile", { x, y, vx, vy, type: "arrow" });
}
