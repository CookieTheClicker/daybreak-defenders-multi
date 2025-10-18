import {
    CANVAS_WIDTH,
    CANVAS_HEIGHT,
    DAY_LENGTH_SECONDS,
    NIGHT_LENGTH_SECONDS,
    MAP_EXPANSION_INTERVAL_DAYS,
    STRUCTURE_TYPES,
    DEFAULT_DIFFICULTY,
    DIFFICULTY_PRESETS,
    ENEMY_STATS
} from "./constants.js";
import { Player } from "./player.js";
import { ResourceManager } from "./resources.js";
import { StructureManager } from "./buildings.js";
import { EnemyWaveManager, drawEnemySprite } from "./enemies.js";
import { World } from "./world.js";
import { initializeInput } from "./input.js";
import { UIManager } from "./ui.js";
import { Inventory, BERRY_STACK_KEY } from "./inventory.js";
import { LootManager } from "./loot.js";
import { EffectManager } from "./effects.js";
import { loadAssets, getAsset, PROP_REGISTRY } from "./assets.js";
import { clamp, distance } from "./utils.js";
import Multiplayer from "./multiplayer.js";
import { setupMultiplayer } from "./multiplayer_integration_example.js";
import { setRandomSeed, ensureSeed, random } from "./rng.js";

const CRAFTABLE_STRUCTURES = ["barricade", "spike", "turret", "computer"];
const STRUCTURE_ICON_PATHS = {
    barricade: "assets/props/barricade.png",
    spike: "assets/props/spike.png",
    turret: "assets/props/turret.png",
    computer: PROP_REGISTRY.computer
}

function formatName(word = "") {
    if (!word) return "";
    return word.charAt(0).toUpperCase() + word.slice(1);
}

const REMOTE_ENEMY_INTERP_MIN_MS = 120;
const REMOTE_ENEMY_INTERP_MAX_MS = 900;

const remoteEnemyState = {
    ghosts: new Map(),
    lastSnapshotTs: null
};

const pendingRemoteAttacks = [];

const nowMs = () =>
    typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now();

const init = async () => {
    await loadAssets();

    const defaultSeed = ensureSeed(Date.now());
    setRandomSeed(defaultSeed);

    const canvas = document.getElementById("gameCanvas");
    const ctx = canvas.getContext("2d");
    canvas.width = CANVAS_WIDTH;
    canvas.height = CANVAS_HEIGHT;

    const difficultySettings = DIFFICULTY_PRESETS[DEFAULT_DIFFICULTY] ?? DIFFICULTY_PRESETS.normal;
    const world = new World();
    const player = new Player(world, world.house.position.x + 20, world.house.position.y + 40, {
        playerHealth: difficultySettings.playerHealth,
        playerDamageMultiplier: difficultySettings.playerDamageMultiplier,
        baseDamageReduction: difficultySettings.baseDamageReduction
    });
    const multiplayerClient = new Multiplayer();
    window.__MP__ = multiplayerClient;
    multiplayerClient.connect();
    let remotePlayers = {};
    const multiplayerState = {
        connected: false,
        lobbyId: null,
        hostId: null,
        seed: defaultSeed,
        isHost: false,
        members: [],
        started: false
    };
    window.multiplayerState = multiplayerState;
    let multiplayerInstance = null;
    const playerVelocity = { x: 0, y: 0 };
    const lastPlayerPosition = { x: player.position.x, y: player.position.y };

    const inventory = new Inventory();
    const resources = new ResourceManager(inventory, world, undefined, {
        resourceYieldMultiplier: difficultySettings.resourceYieldMultiplier
    });
    const structures = new StructureManager(world);
    const NO_VERSION = "__noversion__";
    const structureSync = {
        version: 0,
        lastSentVersion: 0,
        snapshot: []
    };
    const resourceSync = {
        version: 0,
        lastSentVersion: 0,
        snapshot: []
    };
    let lastAppliedStructureVersion = NO_VERSION;
    let lastAppliedResourceVersion = NO_VERSION;

    function serializeStructure(structure) {
        if (!structure) {
            return null;
        }
        const payload = {
            id: structure.id,
            typeKey: structure.typeKey,
            position: {
                x: Number.isFinite(structure.position?.x) ? structure.position.x : 0,
                y: Number.isFinite(structure.position?.y) ? structure.position.y : 0
            },
            rotation: Number.isFinite(structure.rotation) ? structure.rotation : 0,
            level: Number.isFinite(structure.level) ? structure.level : 1,
            hp: Number.isFinite(structure.hp) ? structure.hp : structure.maxHp,
            maxHp: Number.isFinite(structure.maxHp) ? structure.maxHp : structure.hp
        };
        if (structure.stats && typeof structure.stats === "object") {
            payload.stats = { ...structure.stats };
        }
        return payload;
    }

    function buildStructureSnapshot() {
        return structures.structures
            .filter((structure) => structure && structure.typeKey)
            .map((structure) => serializeStructure(structure))
            .filter(Boolean);
    }

    function markStructuresDirty(options = {}) {
        const { bumpVersion = true } = options;
        if (bumpVersion) {
            structureSync.version += 1;
        }
        structureSync.snapshot = buildStructureSnapshot();
        if (!bumpVersion) {
            structureSync.lastSentVersion = structureSync.version;
        }
    }

    function buildResourceSnapshot() {
        if (typeof resources.captureSnapshot === "function") {
            return resources.captureSnapshot();
        }
        return resources.nodes.map((node) => ({
            id: node.id,
            type: node.type,
            capacity: node.capacity,
            amount: node.amount,
            reward: node.reward,
            depleted: node.depleted,
            position: { ...node.position }
        }));
    }

    function markResourcesDirty(options = {}) {
        const { bumpVersion = true } = options;
        if (bumpVersion) {
            resourceSync.version += 1;
        }
        resourceSync.snapshot = buildResourceSnapshot();
        if (!bumpVersion) {
            resourceSync.lastSentVersion = resourceSync.version;
        }
    }

    function isMultiplayerReady() {
        return Boolean(
            multiplayerInstance &&
            multiplayerState.connected &&
            multiplayerState.lobbyId
        );
    }

    function emitMultiplayerEvent(type, payload) {
        if (!isMultiplayerReady()) {
            return;
        }
        try {
            multiplayerInstance.emit(type, payload);
        } catch (error) {
            console.warn("[Multiplayer] Failed to emit event", type, error);
        }
    }

    function broadcastStructurePlacement(structure) {
        const payload = serializeStructure(structure);
        if (!payload) {
            return;
        }
        emitMultiplayerEvent("structure:place", payload);
    }

    function broadcastStructureRemoval(structure) {
        if (!structure?.id) {
            return;
        }
        emitMultiplayerEvent("structure:remove", { id: structure.id });
    }

    function broadcastStructureUpgrade(structure) {
        const payload = serializeStructure(structure);
        if (!payload) {
            return;
        }
        if (multiplayerInstance?.id) {
            payload.sourceId = multiplayerInstance.id;
        }
        emitMultiplayerEvent("structure:update", payload);
    }

    function broadcastResourceNodeUpdate(update) {
        if (!update?.nodeId) {
            return;
        }
        emitMultiplayerEvent("resource:update", {
            nodeId: update.nodeId,
            amount: Number.isFinite(update.remaining) ? update.remaining : update.amount,
            capacity: Number.isFinite(update.capacity) ? update.capacity : undefined,
            depleted: Boolean(update.depleted),
            type: update.type || null
        });
    }

    function serializeHeldItem(held) {
        if (!held) {
            return null;
        }
        const payload = {
            name: held.name || null,
            category: held.category || null,
            slot: held.slot || null,
            iconPath: held.iconPath || null,
            worldAssetKey: held.worldAssetKey || null
        };
        if (Number.isFinite(held.attackBonus)) {
            payload.attackBonus = held.attackBonus;
        }
        if (Number.isFinite(held.gatherBonus)) {
            payload.gatherBonus = held.gatherBonus;
        }
        if (Number.isFinite(held.worldScale)) {
            payload.worldScale = held.worldScale;
        }
        return payload;
    }

    function serializeEquipment(equipment) {
        if (!equipment || typeof equipment !== "object") {
            return { weapon: null, armor: null, tool: null };
        }
        const result = {
            weapon: equipment.weapon ? { name: equipment.weapon.name || null, attackBonus: equipment.weapon.attackBonus ?? null } : null,
            armor: equipment.armor ? {
                name: equipment.armor.name || null,
                damageReduction: equipment.armor.damageReduction ?? null,
                overlayKey: equipment.armor.overlayKey || null,
                overlayColor: equipment.armor.overlayColor || null
            } : null,
            tool: equipment.tool ? { name: equipment.tool.name || null, gatherBonus: equipment.tool.gatherBonus ?? null } : null
        };
        if (equipment.weapon?.iconPath) {
            result.weapon.iconPath = equipment.weapon.iconPath;
        }
        if (equipment.tool?.iconPath) {
            result.tool.iconPath = equipment.tool.iconPath;
        }
        return result;
    }

    function applyHostWorldSnapshots(peers) {
        const hostId = multiplayerState.hostId;
        if (!hostId || !peers) {
            return;
        }
        const hostState = peers[hostId];
        if (!hostState) {
            return;
        }

        if (Array.isArray(hostState.structures)) {
            const incomingVersion = Number.isFinite(hostState.structuresVersion)
                ? hostState.structuresVersion
                : NO_VERSION;
            if (incomingVersion !== lastAppliedStructureVersion) {
                structures.replaceAll(hostState.structures);
                markStructuresDirty({ bumpVersion: false });
                lastAppliedStructureVersion = incomingVersion;
            }
        }

        if (Array.isArray(hostState.resourceNodes)) {
            const incomingVersion = Number.isFinite(hostState.resourcesVersion)
                ? hostState.resourcesVersion
                : NO_VERSION;
            if (incomingVersion !== lastAppliedResourceVersion) {
                resources.replaceNodes(hostState.resourceNodes);
                markResourcesDirty({ bumpVersion: false });
                lastAppliedResourceVersion = incomingVersion;
            }
        }

        // Apply world timing and house state from host so clients stay in sync
        if (hostState.phase && typeof hostState.phase === "string") {
            if (gameState.phase !== hostState.phase) {
                gameState.phase = hostState.phase;
            }
        }
        if (Number.isFinite(hostState.dayNumber)) {
            gameState.dayNumber = hostState.dayNumber;
        }
        if (Number.isFinite(hostState.phaseTimer)) {
            gameState.phaseTimer = hostState.phaseTimer;
        }
        if (Number.isFinite(hostState.houseHp)) {
            if (world && typeof world.house === "object") {
                world.house.hp = hostState.houseHp;
            }
        }

        // If host provides enemy list snapshot, replace local enemies to match host.
        if (Array.isArray(hostState.enemies)) {
            if (multiplayerState.lobbyId && !multiplayerState.isHost) {
                syncRemoteEnemiesFromHostSnapshots(hostState.enemies);
            } else {
                enemyWaves.enemies = hostState.enemies.map((e) => ({ ...(e || {}) }));
            }
        } else if (multiplayerState.lobbyId && !multiplayerState.isHost) {
            syncRemoteEnemiesFromHostSnapshots([]);
        }
        if (typeof hostState.enemiesActive === "boolean") {
            enemyWaves.active = !!hostState.enemiesActive;
        } else if (Array.isArray(hostState.enemies) && hostState.enemies.length > 0) {
            enemyWaves.active = true;
        }
        if (Number.isFinite(hostState.toSpawn)) {
            enemyWaves.toSpawn = hostState.toSpawn;
        }
    }

    function handleRemoteStructurePlacement(payload) {
        if (!payload || !payload.typeKey) {
            return;
        }
        structures.upsertStructureSnapshot(payload, { silent: true });
        const shouldBroadcastLater = multiplayerState.isHost;
        markStructuresDirty({ bumpVersion: shouldBroadcastLater });
    }

    function handleRemoteStructureRemoval(payload) {
        if (!payload?.id) {
            return;
        }
        const removed = structures.removeStructureById(payload.id, { silent: true });
        if (!removed) {
            return;
        }
        const shouldBroadcastLater = multiplayerState.isHost;
        markStructuresDirty({ bumpVersion: shouldBroadcastLater });
    }

    function handleRemoteStructureUpgrade(payload) {
        if (!payload?.id) {
            return;
        }
        if (payload?.sourceId && multiplayerInstance?.id && payload.sourceId === multiplayerInstance.id) {
            return;
        }
        structures.upsertStructureSnapshot(payload, { silent: true });
        const shouldBroadcastLater = multiplayerState.isHost;
        markStructuresDirty({ bumpVersion: shouldBroadcastLater });
    }

    function handleRemoteResourceUpdate(payload) {
        if (!payload?.nodeId) {
            return;
        }
        resources.applyNodeUpdate({
            nodeId: payload.nodeId,
            amount: Number.isFinite(payload.amount) ? payload.amount : undefined,
            capacity: Number.isFinite(payload.capacity) ? payload.capacity : undefined,
            depleted: typeof payload.depleted === "boolean" ? payload.depleted : undefined
        }, { silent: true });
        const shouldBroadcastLater = multiplayerState.isHost;
        markResourcesDirty({ bumpVersion: shouldBroadcastLater });
    }

    structures.onStructurePlaced = (structure) => {
        markStructuresDirty();
        broadcastStructurePlacement(structure);
    };

    structures.onStructureRemoved = (structure) => {
        markStructuresDirty();
        broadcastStructureRemoval(structure);
    };

    structures.onStructureUpdated = (structure, meta = {}) => {
        markStructuresDirty();
        if (meta?.reason === "upgrade" && structure) {
            broadcastStructureUpgrade(structure);
        }
    };

    resources.onSnapshotReplaced = () => {
        const shouldBroadcast = multiplayerState.isHost;
        markResourcesDirty({ bumpVersion: shouldBroadcast });
    };

    markStructuresDirty({ bumpVersion: false });
    markResourcesDirty({ bumpVersion: false });
    const enemyWaves = new EnemyWaveManager(difficultySettings);
    resetRemoteEnemyState();

    function resetRemoteEnemyState(clearLocalEnemies = false) {
        remoteEnemyState.ghosts.clear();
        remoteEnemyState.lastSnapshotTs = null;
        pendingRemoteAttacks.length = 0;
        if (clearLocalEnemies) {
            enemyWaves.enemies = [];
            enemyWaves.toSpawn = 0;
            enemyWaves.active = false;
        }
    }

    function ensureRemoteEnemyGhost(snapshot, timestamp, lerpDurationMs) {
        if (!snapshot) {
            return null;
        }
        const id = Number.isFinite(snapshot.id) ? snapshot.id : null;
        if (id === null) {
            return null;
        }
        const position = {
            x: Number.isFinite(snapshot.position?.x) ? snapshot.position.x : 0,
            y: Number.isFinite(snapshot.position?.y) ? snapshot.position.y : 0
        };
        let ghost = remoteEnemyState.ghosts.get(id);
        if (!ghost) {
            ghost = {
                id,
                position: { ...position },
                lastPosition: { ...position },
                targetPosition: { ...position },
                snapshotTime: timestamp,
                targetTime: timestamp + lerpDurationMs,
                radius: Number.isFinite(snapshot.radius) ? snapshot.radius : 18,
                maxHealth: Number.isFinite(snapshot.maxHealth) ? snapshot.maxHealth : (Number.isFinite(snapshot.health) ? snapshot.health : 1),
                health: Number.isFinite(snapshot.health) ? snapshot.health : (Number.isFinite(snapshot.maxHealth) ? snapshot.maxHealth : 1),
                speed: Number.isFinite(snapshot.speed) ? snapshot.speed : 0,
                damage: Number.isFinite(snapshot.damage) ? snapshot.damage : 0,
                alive: snapshot.alive !== false,
                attackCooldown: Number.isFinite(snapshot.attackCooldown) ? snapshot.attackCooldown : 0,
                waveNumber: Number.isFinite(snapshot.waveNumber) ? snapshot.waveNumber : 0,
                hitFlash: Number.isFinite(snapshot.hitFlash) ? snapshot.hitFlash : 0,
                __lastVisualUpdate: timestamp,
                draw(ctx, camera) {
                    drawEnemySprite(ctx, camera, ghost);
                }
            };
            remoteEnemyState.ghosts.set(id, ghost);
            return ghost;
        }

        ghost.lastPosition.x = ghost.position.x;
        ghost.lastPosition.y = ghost.position.y;
        ghost.targetPosition = { ...position };
        ghost.snapshotTime = timestamp;
        ghost.targetTime = timestamp + lerpDurationMs;
        ghost.radius = Number.isFinite(snapshot.radius) ? snapshot.radius : ghost.radius;
        ghost.maxHealth = Number.isFinite(snapshot.maxHealth) ? snapshot.maxHealth : ghost.maxHealth;
        ghost.health = Number.isFinite(snapshot.health) ? snapshot.health : ghost.health;
        ghost.speed = Number.isFinite(snapshot.speed) ? snapshot.speed : ghost.speed;
        ghost.damage = Number.isFinite(snapshot.damage) ? snapshot.damage : ghost.damage;
        ghost.alive = snapshot.alive !== false;
        ghost.attackCooldown = Number.isFinite(snapshot.attackCooldown) ? snapshot.attackCooldown : ghost.attackCooldown;
        ghost.waveNumber = Number.isFinite(snapshot.waveNumber) ? snapshot.waveNumber : ghost.waveNumber;
        ghost.hitFlash = Number.isFinite(snapshot.hitFlash) ? snapshot.hitFlash : 0;
        return ghost;
    }

    function syncRemoteEnemiesFromHostSnapshots(snapshots = []) {
        if (!Array.isArray(snapshots)) {
            return;
        }
        if (!multiplayerState.lobbyId || multiplayerState.isHost) {
            return;
        }
        const timestamp = nowMs();
        const prev = remoteEnemyState.lastSnapshotTs;
        const interval = prev !== null ? Math.max(0, timestamp - prev) : 0;
        remoteEnemyState.lastSnapshotTs = timestamp;
        const lerpDuration = Math.max(
            REMOTE_ENEMY_INTERP_MIN_MS,
            Math.min(
                REMOTE_ENEMY_INTERP_MAX_MS,
                interval > 0 ? interval * 1.1 : 350
            )
        );
        const seen = new Set();
        for (const snapshot of snapshots) {
            const ghost = ensureRemoteEnemyGhost(snapshot, timestamp, lerpDuration);
            if (ghost) {
                seen.add(ghost.id);
            }
        }
        if (!snapshots.length) {
            resetRemoteEnemyState(true);
        } else {
            for (const id of Array.from(remoteEnemyState.ghosts.keys())) {
                if (!seen.has(id)) {
                    remoteEnemyState.ghosts.delete(id);
                }
            }
        }
        enemyWaves.enemies = Array.from(remoteEnemyState.ghosts.values());
    }

    function updateRemoteEnemyVisuals() {
        if (!multiplayerState.lobbyId || multiplayerState.isHost) {
            return;
        }
        if (!remoteEnemyState.ghosts.size) {
            enemyWaves.enemies = [];
            return;
        }
        const timestamp = nowMs();
        const updated = [];
        for (const ghost of remoteEnemyState.ghosts.values()) {
            const lastVisual = Number.isFinite(ghost.__lastVisualUpdate) ? ghost.__lastVisualUpdate : timestamp;
            const deltaSeconds = Math.max(0, (timestamp - lastVisual) / 1000);
            ghost.__lastVisualUpdate = timestamp;
            const start = ghost.lastPosition || ghost.position;
            const target = ghost.targetPosition || ghost.position;
            const duration = Math.max(
                REMOTE_ENEMY_INTERP_MIN_MS,
                Math.min(
                    REMOTE_ENEMY_INTERP_MAX_MS,
                    (ghost.targetTime ?? timestamp) - (ghost.snapshotTime ?? timestamp)
                )
            );
            ghost.hitFlash = Math.max(0, (ghost.hitFlash ?? 0) - deltaSeconds);
            if (!Number.isFinite(ghost.attackCooldown)) {
                ghost.attackCooldown = 0;
            } else {
                ghost.attackCooldown = Math.max(0, ghost.attackCooldown - deltaSeconds);
            }
            if (duration <= 0) {
                ghost.position.x = target.x;
                ghost.position.y = target.y;
            } else {
                let t = (timestamp - (ghost.snapshotTime ?? timestamp)) / duration;
                if (!Number.isFinite(t)) {
                    t = 1;
                }
                t = Math.max(0, Math.min(1, t));
                ghost.position.x = start.x + (target.x - start.x) * t;
                ghost.position.y = start.y + (target.y - start.y) * t;
            }
            updated.push(ghost);
        }
        enemyWaves.enemies = updated;
    }

    function simulateRemoteEnemyBehavior() {
        updateRemoteEnemyVisuals();
        if (!multiplayerState.lobbyId || multiplayerState.isHost) {
            return { playerHits: [] };
        }
        const playerHits = applyGhostDamageToLocalPlayer();
        return { playerHits };
    }

    function applyGhostDamageToLocalPlayer() {
        if (gameState.phase !== "night") {
            return [];
        }
        if (!player.isAlive()) {
            return [];
        }
        const hits = [];
        for (const ghost of remoteEnemyState.ghosts.values()) {
            if (!ghost || ghost.alive === false) continue;
            const cooldown = Number.isFinite(ghost.attackCooldown) ? ghost.attackCooldown : 0;
            if (cooldown > 0) continue;
            const attackRange = (Number.isFinite(ghost.radius) ? ghost.radius : 18) + (player.size ?? 0) / 2 + 4;
            const dist = distance(ghost.position, player.position);
            if (!Number.isFinite(dist)) continue;
            if (dist <= attackRange) {
                const incoming = Number.isFinite(ghost.damage) ? ghost.damage : 0;
                if (incoming <= 0) {
                    ghost.attackCooldown = ENEMY_STATS.damageInterval;
                    continue;
                }
                const result = player.takeDamage(incoming);
                ghost.attackCooldown = ENEMY_STATS.damageInterval;
                hits.push({ enemy: ghost, damage: result.applied, killed: result.killed });
            }
        }
        return hits;
    }

    function applyRemoteAttackResults(payload) {
        if (!payload || !Array.isArray(payload.hits)) {
            return;
        }
        const isLocalAttacker = payload.sourceId && multiplayerInstance && payload.sourceId === multiplayerInstance.id;
        const displayHits = [];
        for (const hit of payload.hits) {
            const id = Number(hit.id ?? hit.enemyId);
            if (!Number.isFinite(id)) continue;
            const ghost = remoteEnemyState.ghosts.get(id);
            if (!ghost) continue;
            const damageApplied = Number.isFinite(hit.damage) ? hit.damage : 0;
            if (Number.isFinite(hit.health)) {
                ghost.health = Math.max(0, hit.health);
            } else if (damageApplied > 0) {
                const current = Number.isFinite(ghost.health) ? ghost.health : ghost.maxHealth ?? damageApplied;
                ghost.health = Math.max(0, current - damageApplied);
            }
            if (Number.isFinite(hit.maxHealth)) {
                ghost.maxHealth = hit.maxHealth;
            }
            ghost.hitFlash = 0.18;
            const killed = Boolean(hit.killed) || ghost.health <= 0;
            ghost.alive = !killed;
            displayHits.push({ enemy: ghost, damage: damageApplied, killed });
            if (killed) {
                remoteEnemyState.ghosts.delete(id);
            } else {
                remoteEnemyState.ghosts.set(id, ghost);
            }
        }
        enemyWaves.enemies = Array.from(remoteEnemyState.ghosts.values());
        if (displayHits.length) {
            for (const hit of displayHits) {
                const damageValue = Math.round(hit.damage ?? 0);
                if (damageValue > 0) {
                    effects.spawnFloatingText({
                        text: `-${damageValue}`,
                        position: { ...hit.enemy.position },
                        color: "#ffd166"
                    });
                }
                if (hit.killed) {
                    effects.spawnFloatingText({
                        text: "Down!",
                        position: { x: hit.enemy.position.x, y: hit.enemy.position.y - 26 },
                        color: "#ff8ba7"
                    });
                }
            }
        }
        if (isLocalAttacker && displayHits.length) {
            const totalDamage = displayHits.reduce((sum, hit) => sum + Math.round(hit.damage ?? 0), 0);
            if (totalDamage > 0) {
                ui.showMessage(`Hit ${displayHits.length} enemy (${totalDamage} dmg)`, 1, "#ffd166");
            } else {
                ui.showMessage(`Attack connected`, 0.8, "#ffd166");
            }
        }
    }

    function applyDamageToEnemyInstance(enemy, amount) {
        if (!enemy) {
            return { applied: 0, killed: false };
        }
        const damageValue = Number.isFinite(amount) ? amount : 0;
        if (damageValue <= 0) {
            return { applied: 0, killed: false };
        }
        const before = Number.isFinite(enemy.health) ? enemy.health : null;
        let killed = false;
        if (typeof enemy.takeDamage === "function") {
            killed = enemy.takeDamage(damageValue);
        } else if (typeof enemy.health === "number") {
            enemy.health = Math.max(0, enemy.health - damageValue);
            killed = enemy.health <= 0;
            if (killed) {
                enemy.alive = false;
            }
        }
        const after = Number.isFinite(enemy.health) ? enemy.health : before;
        const applied = before !== null && after !== null ? Math.max(0, before - after) : damageValue;
        if (!enemy.alive && !killed) {
            killed = true;
        }
        return { applied, killed };
    }

    function resolveRemoteAttackRequest(request) {
        if (!request) {
            return null;
        }
        const { attackerId, enemyIds, damage } = request;
        if (!Array.isArray(enemyIds) || enemyIds.length === 0) {
            return null;
        }
        const damageValue = Number.isFinite(damage) ? damage : 0;
        if (damageValue <= 0) {
            return null;
        }
        const hits = [];
        for (const rawId of enemyIds) {
            const id = Number(rawId);
            if (!Number.isFinite(id)) continue;
            const enemy = enemyWaves.enemies.find((candidate) => candidate && candidate.id === id);
            if (!enemy || !enemy.alive) continue;
            const wasAlive = enemy.alive;
            const result = applyDamageToEnemyInstance(enemy, damageValue);
            if (result.applied <= 0) continue;

            hits.push({
                id: enemy.id,
                damage: result.applied,
                killed: !enemy.alive,
                health: Number.isFinite(enemy.health) ? enemy.health : null,
                maxHealth: Number.isFinite(enemy.maxHealth) ? enemy.maxHealth : null,
                enemy
            });

            if (effects && result.applied > 0) {
                effects.spawnFloatingText({
                    text: `-${Math.round(result.applied)}`,
                    position: { ...enemy.position },
                    color: "#ffd166"
                });
                if (!enemy.alive) {
                    effects.spawnFloatingText({
                        text: "Down!",
                        position: { x: enemy.position.x, y: enemy.position.y - 26 },
                        color: "#ff8ba7"
                    });
                }
            }

            if (wasAlive && !enemy.alive) {
                if (inventory && random() < 0.35) {
                    const lootDrop = random() < 0.5
                        ? {
                            name: "Scrap",
                            icon: "[S]",
                            description: "Crafting scrap salvaged from raiders.",
                            stackable: true,
                            stackKey: "material:scrap",
                            count: 1
                        }
                        : {
                            name: "Fabric",
                            icon: "[F]",
                            description: "Useful for tailoring upgrades.",
                            stackable: true,
                            stackKey: "material:fabric",
                            count: 1
                        };
                    if (inventory.addItem(lootDrop) && effects) {
                        effects.spawnFloatingText({
                            text: `Loot: ${lootDrop.name}`,
                            position: { ...enemy.position },
                            color: "#7be0a6"
                        });
                    }
                }
                if (effects) {
                    effects.spawnFloatingText({
                        text: "+1 wave XP",
                        position: { ...enemy.position },
                        color: "#ff8ba7"
                    });
                }
            }
        }

        if (!hits.length) {
            return null;
        }

        enemyWaves.enemies = enemyWaves.enemies.filter((enemy) => enemy.alive);
        if (enemyWaves.toSpawn <= 0 && enemyWaves.enemies.length === 0) {
            enemyWaves.active = false;
        }

        return {
            attackerId,
            hits: hits.map((hit) => ({
                id: hit.id,
                damage: hit.damage,
                killed: hit.killed,
                health: Number.isFinite(hit.health) ? hit.health : null,
                maxHealth: Number.isFinite(hit.maxHealth) ? hit.maxHealth : null
            }))
        };
    }

    function processPendingRemoteAttacks() {
        if (!multiplayerState.isHost || pendingRemoteAttacks.length === 0) {
            return;
        }
        const outbound = [];
        while (pendingRemoteAttacks.length) {
            const request = pendingRemoteAttacks.shift();
            const result = resolveRemoteAttackRequest(request);
            if (result) {
                outbound.push(result);
            }
        }
        for (const result of outbound) {
            if (!result.hits || result.hits.length === 0) continue;
            emitMultiplayerEvent("combat:attackResult", {
                sourceId: result.attackerId,
                hits: result.hits
            });
        }
    }

    function handleRemoteAttack(attackerId, payload) {
        if (!multiplayerState.isHost) {
            return;
        }
        if (!attackerId || attackerId === multiplayerInstance?.id) {
            return;
        }
        if (!payload) {
            return;
        }
        const enemyIds = Array.isArray(payload.enemyIds)
            ? payload.enemyIds.map((id) => Number(id)).filter((value) => Number.isFinite(value))
            : [];
        if (!enemyIds.length) {
            return;
        }
        const damage = Number(payload.damage);
        if (!Number.isFinite(damage) || damage <= 0) {
            return;
        }
        pendingRemoteAttacks.push({
            attackerId,
            enemyIds,
            damage
        });
    }
    const loot = new LootManager(world, {
        lootQualityModifier: difficultySettings.lootQualityModifier,
        resourceYield: difficultySettings.resourceYieldMultiplier
    });
    const ui = new UIManager();
    const effects = new EffectManager();
    const input = initializeInput(canvas);
    const pauseOverlay = document.getElementById("pause-overlay");
    const pauseResumeButton = document.getElementById("pause-resume");
    const pauseSettingsButton = document.getElementById("pause-settings");
    const pauseRestartButton = document.getElementById("pause-restart");
    const pauseToggleButton = document.getElementById("pause-toggle-button");
    const settingsModal = document.getElementById("settings-modal");
    const settingsCloseButton = document.getElementById("settings-close");
    const settingsTabs = settingsModal ? Array.from(settingsModal.querySelectorAll(".settings-tab")) : [];
    const settingsPanels = settingsModal ? Array.from(settingsModal.querySelectorAll(".settings-panel")) : [];
    const mobileControlsToggle = document.getElementById("mobile-controls-toggle");
    const mobileControlsRoot = document.getElementById("mobile-controls");
    const joystickBase = mobileControlsRoot ? mobileControlsRoot.querySelector(".joystick-base") : null;
    const joystickThumb = mobileControlsRoot ? mobileControlsRoot.querySelector(".joystick-thumb") : null;
    const mobileActionButtons = mobileControlsRoot ? Array.from(mobileControlsRoot.querySelectorAll(".mobile-button")) : [];
    const restartButton = document.getElementById("game-restart");
    const gameOverOverlay = document.getElementById("game-over-overlay");
    const computerOverlay = document.getElementById("computer-overlay");
    const computerCloseButton = document.getElementById("computer-close");
    const computerFrame = document.getElementById("computer-frame");
    const startOverlay = document.getElementById("start-overlay");
    const startMenuPanel = document.getElementById("start-menu-panel");
    const startDifficultyPanel = document.getElementById("start-difficulty-panel");
    const startMultiplayerPanel = document.getElementById("start-multiplayer-panel");
    const startPanels = {
        menu: startMenuPanel,
        difficulty: startDifficultyPanel,
        multiplayer: startMultiplayerPanel
    };
    const startSingleplayerButton = document.getElementById("start-singleplayer");
    const startMultiplayerButton = document.getElementById("start-multiplayer");
    const startSettingsButton = document.getElementById("start-settings");
    const startDifficultyButton = document.getElementById("start-difficulty");
    const startBackButtons = startOverlay ? Array.from(startOverlay.querySelectorAll(".start-back")) : [];
    const difficultyButtons = startOverlay ? Array.from(startOverlay.querySelectorAll("[data-difficulty]")) : [];
    const mpStatusLabel = document.getElementById("mp-status");
    const mpNameInput = document.getElementById("mp-name-input");
    const mpSeedInput = document.getElementById("mp-seed-input");
    const mpCreateButton = document.getElementById("mp-create-btn");
    const mpJoinForm = document.getElementById("mp-join-form");
    const mpJoinCodeInput = document.getElementById("mp-join-code");
    const mpActions = document.getElementById("mp-actions");
    const mpLobbyInfo = document.getElementById("mp-lobby-info");
    const mpLobbyCode = document.getElementById("mp-lobby-code");
    const mpCopyCodeButton = document.getElementById("mp-copy-code");
    const mpLobbySeed = document.getElementById("mp-lobby-seed");
    const mpNewSeedButton = document.getElementById("mp-new-seed");
    const mpDifficultySelect = document.getElementById("mp-difficulty-select");
    const mpMemberList = document.getElementById("mp-member-list");
    const mpStartButton = document.getElementById("mp-start-btn");
    const mpLeaveButton = document.getElementById("mp-leave-btn");
    const chatPanel = document.getElementById("chat-panel");
    const chatHeader = document.getElementById("chat-header");
    const chatToggleButton = document.getElementById("chat-collapse-btn");
    const chatLog = document.getElementById("chat-log");
    const chatForm = document.getElementById("chat-form");
    const chatInput = document.getElementById("chat-input");
    const CHAT_EVENT = "chat:message";
    const CHAT_HISTORY_LIMIT = 80;
    const CHAT_MESSAGE_LIMIT = 200;
    const CHAT_NAME_LIMIT = 32;
    const CHAT_COLLAPSE_STORAGE_KEY = "dd_chat_collapsed";
    const chatState = {
        entries: [],
        unread: false
    };
    let chatCollapsed = false;
    let lobbyMembersTracked = false;
    const knownLobbyMembers = new Map();

    try {
        const storedCollapseValue = localStorage.getItem(CHAT_COLLAPSE_STORAGE_KEY);
        if (storedCollapseValue === "1") {
            chatCollapsed = true;
        }
    } catch (_) {
        chatCollapsed = false;
    }

    if (chatPanel && !chatPanel.dataset.state) {
        chatPanel.dataset.state = "idle";
    }

    const resolvePlayerNameById = (id, fallback = "Player") => {
        if (!id) {
            return fallback;
        }
        if (multiplayerInstance && id === multiplayerInstance.id) {
            return multiplayerInstance.playerName || fallback;
        }
        if (multiplayerClient && id === multiplayerClient.id) {
            return multiplayerClient.playerName || fallback;
        }
        const memberMatch = multiplayerState.members.find((member) => member?.id === id);
        if (memberMatch?.name) {
            return memberMatch.name;
        }
        const peer = remotePlayers[id];
        if (peer?.name) {
            return peer.name;
        }
        return fallback;
    };

    const sanitizeChatText = (value) => {
        if (typeof value !== "string") {
            return "";
        }
        return value.replace(/\s+/g, " ").trim();
    };

    const sanitizeChatName = (value, fallback = "Player") => {
        const base = sanitizeChatText(value) || fallback;
        return base.slice(0, CHAT_NAME_LIMIT);
    };

    const scrollChatToBottom = () => {
        if (!chatLog) return;
        chatLog.scrollTop = chatLog.scrollHeight;
    };

    const updateChatPanelState = () => {
        if (!chatPanel) {
            return;
        }
        if (chatState.unread) {
            chatPanel.dataset.state = "unread";
        } else if (!chatCollapsed && document.activeElement === chatInput) {
            chatPanel.dataset.state = "active";
        } else {
            chatPanel.dataset.state = "idle";
        }
    };

    const setChatCollapsed = (collapsed, { persist = true } = {}) => {
        if (!chatPanel) {
            chatCollapsed = false;
            return;
        }
        const next = Boolean(collapsed);
        chatCollapsed = next;
        chatPanel.dataset.collapsed = next ? "true" : "false";
        if (chatToggleButton) {
            const expanded = !next;
            chatToggleButton.textContent = expanded ? "Collapse" : "Expand";
            chatToggleButton.setAttribute("aria-expanded", String(expanded));
            chatToggleButton.setAttribute("aria-label", expanded ? "Collapse chat" : "Expand chat");
        }
        if (persist) {
            try {
                localStorage.setItem(CHAT_COLLAPSE_STORAGE_KEY, next ? "1" : "0");
            } catch (_) {
                // ignore persistence issues (private mode, etc.)
            }
        }
        updateChatPanelState();
        if (!next) {
            requestAnimationFrame(scrollChatToBottom);
        }
    };

    setChatCollapsed(chatCollapsed, { persist: false });

    const clearChatUnread = () => {
        if (!chatState.unread) {
            updateChatPanelState();
            return;
        }
        chatState.unread = false;
        updateChatPanelState();
    };

    const markChatUnread = () => {
        chatState.unread = true;
        updateChatPanelState();
    };

    const appendChatMessage = ({ id = "", name = "Player", text = "", system = false, self = false, timestamp = Date.now() }) => {
        if (!chatLog) {
            return;
        }
        const content = sanitizeChatText(text);
        if (!content) {
            return;
        }
        const displayName = sanitizeChatName(name);
        const messageEl = document.createElement("div");
        const classNames = ["chat-message"];
        if (system) {
            classNames.push("chat-message--system");
        }
        if (self) {
            classNames.push("chat-message--self");
        }
        messageEl.className = classNames.join(" ");
        messageEl.dataset.timestamp = String(timestamp);
        messageEl.dataset.sender = id;

        if (system) {
            messageEl.textContent = content;
        } else {
            const authorSpan = document.createElement("span");
            authorSpan.className = "chat-message-author";
            authorSpan.textContent = `${displayName}:`;
            const textSpan = document.createElement("span");
            textSpan.className = "chat-message-text";
            textSpan.textContent = content;
            messageEl.append(authorSpan, textSpan);
        }

        chatLog.append(messageEl);
        chatState.entries.push({ id, element: messageEl });
        while (chatState.entries.length > CHAT_HISTORY_LIMIT) {
            const removed = chatState.entries.shift();
            if (removed?.element?.parentElement) {
                removed.element.parentElement.removeChild(removed.element);
            }
        }
        requestAnimationFrame(scrollChatToBottom);

        if (system) {
            if (!chatState.unread) {
                updateChatPanelState();
            }
            return;
        }

        if (self || document.activeElement === chatInput) {
            clearChatUnread();
        } else {
            markChatUnread();
        }
    };

    const addSystemChatMessage = (message) => {
        appendChatMessage({ text: message, system: true, name: "System" });
    };

    const focusChatInput = () => {
        if (chatCollapsed) {
            setChatCollapsed(false);
        }
        if (!chatInput) {
            return;
        }
        chatInput.focus();
        requestAnimationFrame(scrollChatToBottom);
    };

    const canAutofocusChat = () => {
        if (!chatInput || chatInput.disabled) {
            return false;
        }
        if (startOverlay && startOverlay.getAttribute("aria-hidden") !== "true") {
            return false;
        }
        if (pauseOverlay && pauseOverlay.getAttribute("aria-hidden") !== "true") {
            return false;
        }
        if (settingsModal && settingsModal.getAttribute("aria-hidden") !== "true") {
            return false;
        }
        if (gameOverOverlay && gameOverOverlay.getAttribute("aria-hidden") !== "true") {
            return false;
        }
        return true;
    };

    if (chatPanel) {
        chatPanel.addEventListener("mouseenter", () => {
            if (!chatCollapsed) {
                clearChatUnread();
            }
        });
        chatPanel.addEventListener("mouseleave", updateChatPanelState);
    }

    if (chatToggleButton) {
        chatToggleButton.addEventListener("click", () => {
            setChatCollapsed(!chatCollapsed);
        });
    }

    if (chatHeader) {
        chatHeader.addEventListener("dblclick", () => {
            setChatCollapsed(!chatCollapsed);
        });
    }

    if (chatLog) {
        chatLog.addEventListener("click", clearChatUnread);
    }

    if (chatInput) {
        chatInput.addEventListener("focus", clearChatUnread);
        chatInput.addEventListener("blur", updateChatPanelState);
    }

    if (chatForm && chatInput) {
        chatForm.addEventListener("submit", (event) => {
            event.preventDefault();
            const sanitized = sanitizeChatText(chatInput.value).slice(0, CHAT_MESSAGE_LIMIT);
            if (!sanitized) {
                chatInput.value = "";
                return;
            }
            const senderId = (multiplayerInstance && multiplayerInstance.id) || (multiplayerClient && multiplayerClient.id) || "local";
            const senderName = (multiplayerInstance && multiplayerInstance.playerName) || (multiplayerClient && multiplayerClient.playerName) || "You";
            appendChatMessage({
                id: senderId,
                name: senderName,
                text: sanitized,
                self: true
            });
            chatInput.value = "";
            clearChatUnread();
            const payload = {
                text: sanitized,
                name: senderName,
                senderId,
                ts: Date.now()
            };
            if (multiplayerInstance) {
                multiplayerInstance.emit(CHAT_EVENT, payload);
            } else if (multiplayerClient && typeof multiplayerClient.emit === "function") {
                multiplayerClient.emit(CHAT_EVENT, payload);
            }
        });
    }

    window.addEventListener("keydown", (event) => {
        if (!canAutofocusChat()) {
            return;
        }
        if (event.defaultPrevented) {
            return;
        }
        const active = document.activeElement;
        if (active instanceof HTMLElement) {
            const tag = active.tagName;
            const typing = active.isContentEditable || tag === "INPUT" || tag === "TEXTAREA" || active === chatInput;
            if (typing) {
                return;
            }
        }
        if (event.key === "Enter" || event.key === "/") {
            focusChatInput();
            event.preventDefault();
        }
    });

    window.addEventListener("focus", () => {
        if (!chatState.unread) {
            updateChatPanelState();
        }
    });

    addSystemChatMessage("Chat ready. Press Enter or / to focus.");
    if (mpDifficultySelect) {
        mpDifficultySelect.innerHTML = "";
        Object.values(DIFFICULTY_PRESETS).forEach((preset) => {
            const option = document.createElement("option");
            option.value = preset.key;
            option.textContent = preset.label ?? formatName(preset.key);
            mpDifficultySelect.append(option);
        });
        mpDifficultySelect.value = DEFAULT_DIFFICULTY;
    }
    ui.bindCraftingHandler(attemptCraftStructure);
    ui.bindInventoryItemHandler(handleInventoryItemUse);
    ui.bindInventoryReorderHandler(handleInventoryReorder);

    const gameState = {
        phase: "day",
        dayNumber: 1,
        phaseTimer: DAY_LENGTH_SECONDS,
        placementRotation: 0,
        currentBuildSelection: null,
        rotateLatch: false,
        inventoryOpen: false,
        paused: true,
        pauseMenuOpen: false,
        settingsOpen: false,
        mobileControlsEnabled: false,
        camera: { x: 0, y: 0 },
        gameOver: false,
        inHouse: false,
        craftingOpen: false,
        outsideReturnPosition: null,
        difficultyKey: difficultySettings.key,
        difficultySettings,
        awaitingDifficulty: true,
        lastPlayerHealth: player.health,
        lastPlayerMaxHealth: player.maxHealth,
        playerDamageFlash: 0,
        selectedInventoryIndex: -1,
        berryHintShown: false,
        worldSeed: defaultSeed,
        computerOverlayOpen: false
    };


    let lastCraftingMenuSignature = null;
    let pendingDifficultyIntent = "singleplayer";
    let computerOverlayPrevPaused = false;
    let computerOverlayReturnFocus = null;

    function showStartPanel(panelKey = "menu") {
        const key = startPanels[panelKey] ? panelKey : "menu";
        const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        let focusTarget = null;
        Object.entries(startPanels).forEach(([candidate, panel]) => {
            if (!panel) return;
            const hidden = candidate !== key;
            panel.classList.toggle("start-hidden", hidden);
            if (hidden) {
                panel.setAttribute("aria-hidden", "true");
                panel.setAttribute("inert", "");
                if (activeElement && panel.contains(activeElement)) {
                    activeElement.blur();
                }
            } else {
                panel.setAttribute("aria-hidden", "false");
                panel.removeAttribute("inert");
                if (!focusTarget) {
                    focusTarget = panel.querySelector("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
                }
            }
        });
        if (focusTarget instanceof HTMLElement) {
            focusTarget.focus({ preventScroll: true });
        } else if (startOverlay && typeof startOverlay.focus === "function") {
            startOverlay.focus({ preventScroll: true });
        } else if (canvas && typeof canvas.focus === "function") {
            canvas.focus({ preventScroll: true });
        }
    }

    showStartPanel("menu");
    setLobbyStatus("Create a lobby or join with a code.");

    function setLobbyStatus(message, isError = false) {
        if (!mpStatusLabel) {
            return;
        }
        mpStatusLabel.textContent = message;
        mpStatusLabel.classList.toggle("is-error", Boolean(isError));
    }

    function applyWorldSeed(seed, options = {}) {
        if (!Number.isFinite(seed)) {
            return;
        }
        if (!gameState.awaitingDifficulty && !options.allowDuringGame) {
            return;
        }
        const normalized = ensureSeed(seed);
        if (!options.force && gameState.worldSeed === normalized) {
            return;
        }
        setRandomSeed(normalized);
        gameState.worldSeed = normalized;
        multiplayerState.seed = normalized;
        if (resources) {
            resources.initialized = false;
            resources.onDayStart(gameState.dayNumber);
            markResourcesDirty();
        }
        if (loot) {
            loot.generateInitialChests();
        }
        if (structures) {
            structures.structures = [];
            markStructuresDirty();
        }
        if (enemyWaves) {
            enemyWaves.enemies.length = 0;
            enemyWaves.toSpawn = 0;
            enemyWaves.active = false;
        }
        refreshResourceUI();
    }

    function updateDifficultySelection(key, options = {}) {
        const preset = DIFFICULTY_PRESETS[key] ? applyDifficultySettings(key) : applyDifficultySettings(DEFAULT_DIFFICULTY);
        if (mpDifficultySelect && mpDifficultySelect.value !== preset.key) {
            mpDifficultySelect.value = preset.key;
        }
        highlightDifficultyButtons(preset.key);
        if (options.broadcast && multiplayerState.isHost && multiplayerInstance) {
            multiplayerInstance.emit("difficulty", { key: preset.key });
        }
        return preset;
    }

    function updateLobbyUI() {
        if (!mpLobbyInfo || !mpActions) {
            return;
        }
        const inLobby = Boolean(multiplayerState.lobbyId);
        mpLobbyInfo.classList.toggle("start-hidden", !inLobby);
        mpActions.classList.toggle("start-hidden", inLobby);
        if (mpCopyCodeButton) {
            mpCopyCodeButton.disabled = !inLobby;
        }
        if (mpNewSeedButton) {
            mpNewSeedButton.disabled = !multiplayerState.isHost;
        }
        if (mpStartButton) {
            mpStartButton.disabled = !multiplayerState.isHost || multiplayerState.members.length === 0 || multiplayerState.started;
        }
        if (mpLeaveButton) {
            mpLeaveButton.disabled = !inLobby;
        }
        if (mpDifficultySelect) {
            mpDifficultySelect.disabled = !multiplayerState.isHost;
        }
        if (!inLobby) {
            if (mpLobbyCode) mpLobbyCode.textContent = "----";
            if (mpLobbySeed) mpLobbySeed.textContent = "—";
            if (mpMemberList) mpMemberList.innerHTML = "";
            setLobbyStatus("Create a lobby or join with a code.");
            return;
        }

        if (mpLobbyCode) {
            mpLobbyCode.textContent = multiplayerState.lobbyId;
        }
        if (mpLobbySeed) {
            mpLobbySeed.textContent = multiplayerState.seed ?? "—";
        }
        if (mpDifficultySelect) {
            mpDifficultySelect.value = gameState.difficultyKey;
        }
        if (mpMemberList) {
            mpMemberList.innerHTML = "";
            for (const member of multiplayerState.members) {
                const li = document.createElement("li");
                const label = document.createElement("span");
                const name = member?.name?.trim?.() || "Player";
                label.textContent = name;
                const badgeContainer = document.createElement("span");
                badgeContainer.style.display = "flex";
                badgeContainer.style.gap = "6px";
                if (member?.id === multiplayerState.hostId) {
                    const hostBadge = document.createElement("span");
                    hostBadge.className = "mp-role";
                    hostBadge.textContent = "Host";
                    badgeContainer.append(hostBadge);
                }
                if (multiplayerInstance?.id && member?.id === multiplayerInstance.id) {
                    const youBadge = document.createElement("span");
                    youBadge.className = "mp-role";
                    youBadge.textContent = "You";
                    badgeContainer.append(youBadge);
                }
                li.append(label);
                li.append(badgeContainer);
                mpMemberList.append(li);
            }
        }
        const waitingMsg = multiplayerState.isHost
            ? "Share the code and start when everyone is ready."
            : "Waiting for the host to start the game.";
        setLobbyStatus(waitingMsg);
    }

    function startMultiplayerGame() {
        if (!multiplayerState.lobbyId) {
            return;
        }
        applyWorldSeed(multiplayerState.seed, { force: true });
        multiplayerState.started = true;
        beginGameWithDifficulty(gameState.difficultyKey);
    }

    if (startSingleplayerButton) {
        startSingleplayerButton.addEventListener("click", () => {
            pendingDifficultyIntent = "singleplayer";
            showStartPanel("difficulty");
            setLobbyStatus("Create a lobby or join with a code.");
        });
    }

    if (startDifficultyButton) {
        startDifficultyButton.addEventListener("click", () => {
            pendingDifficultyIntent = multiplayerState.lobbyId ? "multiplayer" : "adjust";
            showStartPanel("difficulty");
        });
    }

    if (startMultiplayerButton) {
        startMultiplayerButton.addEventListener("click", () => {
            pendingDifficultyIntent = "multiplayer";
            showStartPanel("multiplayer");
            if (!multiplayerInstance) {
                setLobbyStatus("Multiplayer client unavailable. Check your connection.", true);
            }
        });
    }

    if (startSettingsButton) {
        startSettingsButton.addEventListener("click", () => {
            openSettings();
        });
    }

    startBackButtons.forEach((button) => {
        button.addEventListener("click", () => {
            pendingDifficultyIntent = "singleplayer";
            const target = button.dataset.target || "menu";
            showStartPanel(target);
        });
    });

    if (mpNameInput) {
        const storedName = localStorage.getItem("dd_name");
        if (storedName) {
            mpNameInput.value = storedName;
        }
        mpNameInput.addEventListener("change", () => {
            const value = mpNameInput.value.trim();
            if (!value) {
                return;
            }
            localStorage.setItem("dd_name", value);
            if (multiplayerInstance?.socket) {
                multiplayerInstance.playerName = value;
                multiplayerInstance.socket.emit("hello", { name: value, ts: Date.now() });
            }
        });
    }

    if (mpJoinCodeInput) {
        mpJoinCodeInput.addEventListener("input", () => {
            mpJoinCodeInput.value = mpJoinCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
        });
    }

    if (mpDifficultySelect) {
        mpDifficultySelect.addEventListener("change", () => {
            const key = mpDifficultySelect.value || DEFAULT_DIFFICULTY;
            pendingDifficultyIntent = multiplayerState.lobbyId ? "multiplayer" : "adjust";
            updateDifficultySelection(key, { broadcast: true });
        });
    }

    if (mpCopyCodeButton) {
        mpCopyCodeButton.addEventListener("click", async () => {
            if (!multiplayerState.lobbyId) return;
            try {
                await navigator.clipboard.writeText(multiplayerState.lobbyId);
                setLobbyStatus("Lobby code copied to clipboard.");
            } catch (error) {
                console.warn("Clipboard copy failed", error);
                setLobbyStatus(`Code: ${multiplayerState.lobbyId}`, true);
            }
        });
    }

    if (mpNewSeedButton) {
        mpNewSeedButton.addEventListener("click", () => {
            if (!multiplayerState.isHost || !multiplayerInstance) {
                return;
            }
            const nextSeed = ensureSeed(Date.now() + Math.floor(Math.random() * 0xffffffff));
            multiplayerInstance.setLobbySeed(nextSeed);
            multiplayerState.seed = nextSeed;
            mpLobbySeed.textContent = nextSeed;
            setLobbyStatus("Requested new seed.");
        });
    }

    if (mpCreateButton) {
        mpCreateButton.addEventListener("click", async () => {
            if (!multiplayerInstance) {
                setLobbyStatus("Multiplayer client unavailable.", true);
                return;
            }
            const name = (mpNameInput?.value?.trim() || multiplayerInstance.playerName || "Player").slice(0, 32);
            const seedValue = mpSeedInput?.value?.trim();
            const seed = seedValue ? ensureSeed(seedValue) : undefined;
            try {
                setLobbyStatus("Creating lobby...");
                await multiplayerInstance.createLobby({ playerName: name, seed });
                setLobbyStatus("Lobby created. Share the code and wait for friends.");
                if (mpNameInput) {
                    mpNameInput.value = name;
                    localStorage.setItem("dd_name", name);
                }
            } catch (error) {
                console.error(error);
                setLobbyStatus(`Failed to create lobby: ${error.message}`, true);
            }
        });
    }

    if (mpJoinForm) {
        mpJoinForm.addEventListener("submit", async (event) => {
            event.preventDefault();
            if (!multiplayerInstance) {
                setLobbyStatus("Multiplayer client unavailable.", true);
                return;
            }
            const code = mpJoinCodeInput?.value?.trim()?.toUpperCase();
            if (!code) {
                setLobbyStatus("Enter a lobby code to join.", true);
                return;
            }
            const name = (mpNameInput?.value?.trim() || multiplayerInstance.playerName || "Player").slice(0, 32);
            try {
                setLobbyStatus("Joining lobby...");
                await multiplayerInstance.joinLobby(code, { playerName: name });
                setLobbyStatus("Joined lobby. Waiting for the host.");
                if (mpNameInput) {
                    localStorage.setItem("dd_name", name);
                }
            } catch (error) {
                console.error(error);
                setLobbyStatus(`Failed to join lobby: ${error.message}`, true);
            }
        });
    }

    if (mpLeaveButton) {
        mpLeaveButton.addEventListener("click", () => {
            if (!multiplayerInstance) {
                return;
            }
            multiplayerInstance.leaveLobby();
            setLobbyStatus("Left lobby.");
        });
    }

    if (mpStartButton) {
        mpStartButton.addEventListener("click", () => {
            if (!multiplayerInstance || !multiplayerState.isHost) {
                return;
            }
            multiplayerInstance.startLobbyGame();
            setLobbyStatus("Starting game...");
        });
    }

    updateLobbyUI();

    window.remotePlayers = () => remotePlayers;

    multiplayerInstance = setupMultiplayer(
        () => {
            const held = player.equipment.tool || player.equipment.weapon;
            const snapshot = {
                x: player.position.x,
                y: player.position.y,
                dir: Number.isFinite(player.lastAimAngle) ? player.lastAimAngle : 0,
                hp: Number.isFinite(player.health) ? player.health : 100,
                anim: player.swingTimer > 0 ? "attack" : "idle",
                vx: Number.isFinite(playerVelocity.x) ? playerVelocity.x : 0,
                vy: Number.isFinite(playerVelocity.y) ? playerVelocity.y : 0,
                currentBuildSelection: gameState.currentBuildSelection,
                selectedInventoryIndex: gameState.selectedInventoryIndex,
                heldItem: serializeHeldItem(held),
                equipment: serializeEquipment(player.equipment),
                structureKits: inventory.getStructureKitCounts
                    ? inventory.getStructureKitCounts(CRAFTABLE_STRUCTURES)
                    : {},
                inventoryResources: inventory.getResources(),
                phase: gameState.phase,
                dayNumber: gameState.dayNumber,
                phaseTimer: Number.isFinite(gameState.phaseTimer) ? gameState.phaseTimer : 0,
                houseHp: world?.house?.hp,
                inHouse: Boolean(gameState.inHouse)
            };

            if (structureSync.version !== structureSync.lastSentVersion) {
                snapshot.structuresVersion = structureSync.version;
                snapshot.structures = structureSync.snapshot;
                structureSync.lastSentVersion = structureSync.version;
            }

            if (resourceSync.version !== resourceSync.lastSentVersion) {
                snapshot.resourcesVersion = resourceSync.version;
                snapshot.resourceNodes = resourceSync.snapshot;
                resourceSync.lastSentVersion = resourceSync.version;
            }

            if (multiplayerState.isHost) {
                snapshot.enemies = enemyWaves.enemies.map((enemy) => ({
                    id: Number.isFinite(enemy.id) ? enemy.id : null,
                    position: {
                        x: Number.isFinite(enemy.position?.x) ? enemy.position.x : 0,
                        y: Number.isFinite(enemy.position?.y) ? enemy.position.y : 0
                    },
                    radius: Number.isFinite(enemy.radius) ? enemy.radius : 18,
                    health: Number.isFinite(enemy.health) ? enemy.health : 0,
                    maxHealth: Number.isFinite(enemy.maxHealth) ? enemy.maxHealth : 0,
                    speed: Number.isFinite(enemy.speed) ? enemy.speed : 0,
                    damage: Number.isFinite(enemy.damage) ? enemy.damage : 0,
                    alive: enemy.alive !== false,
                    attackCooldown: Number.isFinite(enemy.attackCooldown) ? enemy.attackCooldown : 0,
                    waveNumber: Number.isFinite(enemy.waveNumber) ? enemy.waveNumber : 0,
                    hitFlash: Number.isFinite(enemy.hitFlash) ? enemy.hitFlash : 0
                }));
                snapshot.enemiesActive = !!enemyWaves.active;
                snapshot.toSpawn = Number.isFinite(enemyWaves.toSpawn) ? enemyWaves.toSpawn : 0;
            }

            return snapshot;
        },
        (peers) => {
            remotePlayers = peers ?? {};
            applyHostWorldSnapshots(peers);
        }
    );

    if (multiplayerInstance) {
        multiplayerState.connected = true;
        if (mpNameInput && mpNameInput.value.trim()) {
            multiplayerInstance.playerName = mpNameInput.value.trim();
        }

        multiplayerInstance.onPeers((peers) => {
            remotePlayers = peers ?? {};
            applyHostWorldSnapshots(peers);
        });

        multiplayerInstance.onLobbyUpdate((snapshot) => {
            const previousLobbyId = multiplayerState.lobbyId;
            const previousHostId = multiplayerState.hostId;
            multiplayerState.lobbyId = snapshot?.lobbyId || null;
            multiplayerState.hostId = snapshot?.hostId || null;
            multiplayerState.isHost = Boolean(snapshot?.hostId && multiplayerInstance.id === snapshot.hostId);
            const wasHost = Boolean(previousHostId && multiplayerInstance.id === previousHostId);
            if (wasHost !== multiplayerState.isHost) {
                resetRemoteEnemyState(true);
            }
            if (previousLobbyId && !multiplayerState.lobbyId && !wasHost) {
                resetRemoteEnemyState(true);
            }
            if (Number.isFinite(snapshot?.seed)) {
                multiplayerState.seed = snapshot.seed >>> 0;
            }
            multiplayerState.members = Array.isArray(snapshot?.members) ? snapshot.members : [];
            multiplayerState.started = Boolean(snapshot?.started);
            if (previousLobbyId !== multiplayerState.lobbyId) {
                knownLobbyMembers.clear();
                lobbyMembersTracked = false;
                if (multiplayerState.lobbyId) {
                    addSystemChatMessage(`Joined lobby ${multiplayerState.lobbyId}.`);
                }
            }
            if (!lobbyMembersTracked) {
                knownLobbyMembers.clear();
                for (const member of multiplayerState.members) {
                    if (!member?.id) {
                        continue;
                    }
                    knownLobbyMembers.set(member.id, sanitizeChatName(member.name || resolvePlayerNameById(member.id)));
                }
                lobbyMembersTracked = true;
            } else {
                const previousMembers = new Map(knownLobbyMembers);
                knownLobbyMembers.clear();
                for (const member of multiplayerState.members) {
                    if (!member?.id) {
                        continue;
                    }
                    const displayName = sanitizeChatName(member.name || resolvePlayerNameById(member.id));
                    knownLobbyMembers.set(member.id, displayName);
                    if (!previousMembers.has(member.id)) {
                        addSystemChatMessage(`${displayName} joined the lobby.`);
                    } else {
                        previousMembers.delete(member.id);
                    }
                }
                for (const [leftId, leftName] of previousMembers.entries()) {
                    const departureName = sanitizeChatName(leftName || resolvePlayerNameById(leftId));
                    addSystemChatMessage(`${departureName} left the lobby.`);
                }
            }
            if (previousHostId !== multiplayerState.hostId) {
                lastAppliedStructureVersion = NO_VERSION;
                lastAppliedResourceVersion = NO_VERSION;
                if (previousHostId && multiplayerState.hostId && previousHostId !== multiplayerState.hostId) {
                    const newHostName = sanitizeChatName(resolvePlayerNameById(multiplayerState.hostId, "Host"));
                    addSystemChatMessage(`${newHostName} is now the host.`);
                }
            }
            if (!multiplayerState.started && multiplayerState.seed != null) {
                applyWorldSeed(multiplayerState.seed, { force: true });
            }
            updateLobbyUI();
        });

        multiplayerInstance.onLobbySeed(({ seed }) => {
            if (Number.isFinite(seed)) {
                multiplayerState.seed = seed >>> 0;
                applyWorldSeed(multiplayerState.seed, { force: true });
                if (mpLobbySeed) {
                    mpLobbySeed.textContent = multiplayerState.seed;
                }
                setLobbyStatus("Seed synchronised.");
            }
        });

        multiplayerInstance.onLobbyLeft(() => {
            multiplayerState.lobbyId = null;
            multiplayerState.hostId = null;
            multiplayerState.isHost = false;
            multiplayerState.members = [];
            multiplayerState.started = false;
            multiplayerState.seed = defaultSeed;
            remotePlayers = {};
            lastAppliedStructureVersion = NO_VERSION;
            lastAppliedResourceVersion = NO_VERSION;
            knownLobbyMembers.clear();
            lobbyMembersTracked = false;
            updateLobbyUI();
            showStartPanel("menu");
            addSystemChatMessage("You left the lobby.");
        });

        multiplayerInstance.onLobbyStarted(({ seed }) => {
            if (Number.isFinite(seed)) {
                multiplayerState.seed = seed >>> 0;
            }
            setLobbyStatus("Match starting...");
            startMultiplayerGame();
            addSystemChatMessage("Match starting...");
        });

        multiplayerInstance.onLobbyError((error) => {
            if (!error) return;
            setLobbyStatus(error.error ? `Lobby error: ${error.error}` : "Lobby error.", true);
            if (error?.error) {
                addSystemChatMessage(`Lobby error: ${sanitizeChatText(error.error)}`);
            }
        });

        multiplayerInstance.onEvent("structure:place", ({ payload }) => {
            handleRemoteStructurePlacement(payload);
        });

        multiplayerInstance.onEvent("structure:remove", ({ payload }) => {
            handleRemoteStructureRemoval(payload);
        });

        multiplayerInstance.onEvent("structure:update", ({ payload }) => {
            handleRemoteStructureUpgrade(payload);
        });

        multiplayerInstance.onEvent("resource:update", ({ payload }) => {
            handleRemoteResourceUpdate(payload);
        });

        multiplayerInstance.onEvent("difficulty", ({ payload }) => {
            const key = payload?.key;
            if (key && DIFFICULTY_PRESETS[key]) {
                pendingDifficultyIntent = "multiplayer";
                updateDifficultySelection(key);
            }
        });

        multiplayerInstance.onEvent(CHAT_EVENT, ({ payload, from }) => {
            if (!payload) {
                return;
            }
            if (payload.system) {
                const systemMessage = sanitizeChatText(payload.text).slice(0, CHAT_MESSAGE_LIMIT);
                if (systemMessage) {
                    addSystemChatMessage(systemMessage);
                }
                return;
            }
            const rawText = sanitizeChatText(payload.text).slice(0, CHAT_MESSAGE_LIMIT);
            if (!rawText) {
                return;
            }
            const senderId = payload.senderId || from || "";
            if (senderId && multiplayerInstance && senderId === multiplayerInstance.id) {
                return;
            }
            const displayName = sanitizeChatName(payload.name || resolvePlayerNameById(senderId));
            appendChatMessage({
                id: senderId,
                name: displayName,
                text: rawText,
                self: false,
                timestamp: Number.isFinite(payload.ts) ? payload.ts : Date.now()
            });
        });

        // Host: periodically broadcast authoritative world snapshot so clients stay synced.
        let _worldSnapshotInterval = null;
        function buildWorldSnapshot() {
            return {
                phase: gameState.phase,
                dayNumber: gameState.dayNumber,
                phaseTimer: Number.isFinite(gameState.phaseTimer) ? gameState.phaseTimer : 0,
                houseHp: world?.house?.hp ?? null,
                structuresVersion: structureSync.version,
                structures: structureSync.snapshot,
                resourcesVersion: resourceSync.version,
                resourceNodes: resourceSync.snapshot,
                enemies: enemyWaves.enemies.map((e) => ({
                    id: Number.isFinite(e.id) ? e.id : null,
                    position: e.position,
                    radius: e.radius,
                    health: e.health,
                    maxHealth: e.maxHealth,
                    speed: e.speed,
                    damage: e.damage,
                    alive: e.alive,
                    attackCooldown: e.attackCooldown,
                    waveNumber: e.waveNumber,
                    hitFlash: e.hitFlash
                })),
                enemiesActive: !!enemyWaves.active,
                toSpawn: enemyWaves.toSpawn || 0,
                chests: loot && Array.isArray(loot.chests) ? loot.chests.map((c) => ({ id: c.id, opened: !!c.opened })) : []
            };
        }

        multiplayerInstance.onEvent("combat:attack", ({ payload, from }) => {
            if (!multiplayerState.isHost) return;
            handleRemoteAttack(from, payload);
        });

        multiplayerInstance.onEvent("combat:attackResult", ({ payload }) => {
            if (multiplayerState.isHost) return;
            applyRemoteAttackResults(payload);
        });

        multiplayerInstance.onEvent("world:snapshot", ({ payload, from }) => {
            // Only apply if not host
            if (multiplayerState.isHost) return;
            if (!payload) return;
            // Merge snapshot into peers-based apply path to keep things consistent
            const fakeHostState = { ...payload };
            // Apply structure/resource versions directly if present
            if (Array.isArray(fakeHostState.structures)) {
                const incomingVersion = Number.isFinite(fakeHostState.structuresVersion) ? fakeHostState.structuresVersion : NO_VERSION;
                if (incomingVersion !== lastAppliedStructureVersion) {
                    structures.replaceAll(fakeHostState.structures);
                    markStructuresDirty({ bumpVersion: false });
                    lastAppliedStructureVersion = incomingVersion;
                }
            }
            if (Array.isArray(fakeHostState.resourceNodes)) {
                const incomingVersion = Number.isFinite(fakeHostState.resourcesVersion) ? fakeHostState.resourcesVersion : NO_VERSION;
                if (incomingVersion !== lastAppliedResourceVersion) {
                    resources.replaceNodes(fakeHostState.resourceNodes);
                    markResourcesDirty({ bumpVersion: false });
                    lastAppliedResourceVersion = incomingVersion;
                }
            }
            // Apply timing/house/enemies/chests
            if (fakeHostState.phase) gameState.phase = fakeHostState.phase;
            if (Number.isFinite(fakeHostState.dayNumber)) gameState.dayNumber = fakeHostState.dayNumber;
            if (Number.isFinite(fakeHostState.phaseTimer)) gameState.phaseTimer = fakeHostState.phaseTimer;
            if (Number.isFinite(fakeHostState.houseHp) && world && typeof world.house === "object") world.house.hp = fakeHostState.houseHp;
            if (Array.isArray(fakeHostState.enemies)) {
                if (multiplayerState.lobbyId && !multiplayerState.isHost) {
                    syncRemoteEnemiesFromHostSnapshots(fakeHostState.enemies);
                } else {
                    enemyWaves.enemies = fakeHostState.enemies.map((e) => ({ ...(e || {}) }));
                }
            } else if (multiplayerState.lobbyId && !multiplayerState.isHost) {
                syncRemoteEnemiesFromHostSnapshots([]);
            }
            if (typeof fakeHostState.enemiesActive === "boolean") {
                enemyWaves.active = !!fakeHostState.enemiesActive;
            } else if (Array.isArray(fakeHostState.enemies) && fakeHostState.enemies.length > 0) {
                enemyWaves.active = true;
            }
            if (Number.isFinite(fakeHostState.toSpawn)) {
                enemyWaves.toSpawn = fakeHostState.toSpawn;
            }
            if (Array.isArray(fakeHostState.chests) && loot) {
                // Apply opened state for known chests; do not override positions so clients keep their own chest placements
                for (const chestState of fakeHostState.chests) {
                    const local = loot.chests.find((c) => c.id === chestState.id);
                    if (local && typeof chestState.opened === "boolean") {
                        local.opened = chestState.opened;
                    }
                }
            }
        });

        // Start/stop snapshot broadcast when lobby state changes
        const startWorldBroadcast = () => {
            if (_worldSnapshotInterval) return;
            _worldSnapshotInterval = setInterval(() => {
                if (multiplayerState.isHost && multiplayerInstance) {
                    try {
                        multiplayerInstance.emit("world:snapshot", buildWorldSnapshot());
                    } catch (err) {
                        // ignore
                    }
                }
            }, 1000);
        };
        const stopWorldBroadcast = () => {
            if (_worldSnapshotInterval) {
                clearInterval(_worldSnapshotInterval);
                _worldSnapshotInterval = null;
            }
        };

        // Start broadcasting if already host
        if (multiplayerState.isHost) startWorldBroadcast();

        // Watch for lobby changes to start/stop
        multiplayerInstance.onLobbyUpdate((snapshot) => {
            if (snapshot?.hostId && multiplayerInstance.id === snapshot.hostId) {
                startWorldBroadcast();
            } else {
                stopWorldBroadcast();
            }
        });
    } else {
        setLobbyStatus("Multiplayer client unavailable. Socket.IO missing?", true);
        if (startMultiplayerButton) {
            startMultiplayerButton.disabled = true;
        }
    }

    function updatePauseButtonState() {
        if (!pauseToggleButton) {
            return;
        }
        const isMenuOpen = Boolean(gameState.pauseMenuOpen);
        const disableButton = gameState.awaitingDifficulty || gameState.gameOver;
        pauseToggleButton.disabled = disableButton;
        pauseToggleButton.textContent = isMenuOpen ? "Resume" : "Pause";
        pauseToggleButton.setAttribute("aria-pressed", isMenuOpen ? "true" : "false");
        pauseToggleButton.setAttribute("aria-label", isMenuOpen ? "Resume game" : "Pause game");
        pauseToggleButton.classList.toggle("is-paused", isMenuOpen);
    }

    updatePauseButtonState();

    const minimapConfig = {
        width: 220,
        height: 160,
        margin: 18,
        backgroundDay: "rgba(18, 26, 36, 0.9)",
        backgroundNight: "rgba(8, 12, 20, 0.9)",
        border: "rgba(86, 112, 149, 0.85)",
        enemyColor: "#ff6b81",
        playerColor: "#7be0a6",
        houseColor: "#f4d160",
        cameraStroke: "rgba(255, 255, 255, 0.55)",
        resourceColors: {
            wood: "#5fa364",
            stone: "#b9bdc4",
            metal: "#8aa8ff"
        },
        structureColors: {
            barricade: "#c49b66",
            spike: "#d36b5f",
            turret: "#84b6ff"
        }
    };

    const houseInterior = {
        width: 520,
        height: 340,
        wallThickness: 48,
        wallColor: "#2a1c13",
        floorColor: "#735b47",
        rug: { x: 150, y: 140, width: 220, height: 120 },
        rugColor: "rgba(248, 214, 138, 0.3)",
        door: {
            position: { x: 260, y: 318 },
            width: 110,
            height: 54,
            radius: 52
        },
        spawn: { x: 260, y: 220 },
        furniture: [
            { x: 82, y: 112, width: 124, height: 50, color: "#4a3c3b" },
            { x: 320, y: 98, width: 112, height: 62, color: "#3b4a3f" },
            { x: 118, y: 236, width: 86, height: 44, color: "#3c4254" }
        ],
        craftingTable: {
            position: { x: 360, y: 176 },
            width: 120,
            height: 72,
            radius: 72
        },
        computerPlacement: {
            width: 120,
            height: 72,
            interactRadius: 84,
            clearance: 8,
            snapMargin: 28
        },
        computers: []
    };
    const doorReachY = Math.max(
        houseInterior.door.position.y - 12,
        houseInterior.height - houseInterior.wallThickness - 28
    );
    houseInterior.bounds = {
        minX: houseInterior.wallThickness + 34,
        maxX: houseInterior.width - houseInterior.wallThickness - 34,
        minY: houseInterior.wallThickness + 28,
        maxY: Math.min(doorReachY, houseInterior.height - 36)
    };

    function getInteriorOffsets() {
        return {
            offsetX: Math.floor((CANVAS_WIDTH - houseInterior.width) / 2),
            offsetY: Math.floor((CANVAS_HEIGHT - houseInterior.height) / 2)
        };
    }

    function canvasToInteriorPosition(canvasX, canvasY) {
        if (!Number.isFinite(canvasX) || !Number.isFinite(canvasY)) {
            return null;
        }
        const { offsetX, offsetY } = getInteriorOffsets();
        return {
            x: canvasX - offsetX,
            y: canvasY - offsetY
        };
    }

    function makeRect(position, width, height, padding = 0) {
        return {
            left: position.x - width / 2 - padding,
            right: position.x + width / 2 + padding,
            top: position.y - height / 2 - padding,
            bottom: position.y + height / 2 + padding
        };
    }

    function rectanglesOverlap(a, b) {
        return !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
    }

    function isRectInsideInteriorBounds(rect) {
        const bounds = houseInterior.bounds;
        return rect.left >= bounds.minX
            && rect.right <= bounds.maxX
            && rect.top >= bounds.minY
            && rect.bottom <= bounds.maxY;
    }

    function isInteriorComputerPlacementValid(position) {
        if (!position) {
            return false;
        }
        const placement = houseInterior.computerPlacement;
        const clearance = placement.clearance ?? 0;
        const rect = makeRect(position, placement.width, placement.height, clearance);
        if (!isRectInsideInteriorBounds(rect)) {
            return false;
        }
        for (const piece of houseInterior.furniture) {
            const furnitureRect = {
                left: piece.x - clearance,
                right: piece.x + piece.width + clearance,
                top: piece.y - clearance,
                bottom: piece.y + piece.height + clearance
            };
            if (rectanglesOverlap(rect, furnitureRect)) {
                return false;
            }
        }
        const table = houseInterior.craftingTable;
        if (table) {
            const tableRect = makeRect(table.position, table.width, table.height, clearance + 8);
            if (rectanglesOverlap(rect, tableRect)) {
                return false;
            }
        }
        for (const computer of houseInterior.computers) {
            const existingRect = makeRect(computer.position, computer.width, computer.height, clearance);
            if (rectanglesOverlap(rect, existingRect)) {
                return false;
            }
        }
        return true;
    }

    function clampInteriorPosition(position, width, height) {
        const bounds = houseInterior.bounds;
        const halfW = width / 2;
        const halfH = height / 2;
        return {
            x: clamp(position.x, bounds.minX + halfW, bounds.maxX - halfW),
            y: clamp(position.y, bounds.minY + halfH, bounds.maxY - halfH)
        };
    }

    function findInteriorComputerNear(position, padding = 36) {
        if (!position) {
            return null;
        }
        for (const computer of houseInterior.computers) {
            const halfW = computer.width / 2 + padding;
            const halfH = computer.height / 2 + padding;
            if (Math.abs(position.x - computer.position.x) <= halfW && Math.abs(position.y - computer.position.y) <= halfH) {
                return computer;
            }
        }
        return null;
    }

    function getPreferredComputerLocations() {
        const placement = houseInterior.computerPlacement;
        const margin = Number.isFinite(placement.snapMargin) ? placement.snapMargin : 28;
        const spots = [
            {
                x: houseInterior.bounds.maxX - placement.width / 2 - margin,
                y: houseInterior.bounds.minY + placement.height / 2 + margin
            },
            {
                x: houseInterior.bounds.maxX - placement.width / 2 - margin,
                y: houseInterior.bounds.maxY - placement.height / 2 - margin
            },
            {
                x: houseInterior.bounds.minX + placement.width / 2 + margin,
                y: houseInterior.bounds.maxY - placement.height / 2 - margin
            },
            {
                x: houseInterior.bounds.minX + placement.width / 2 + margin,
                y: houseInterior.bounds.minY + placement.height / 2 + margin
            }
        ];
        return spots.map((spot) => clampInteriorPosition(spot, placement.width, placement.height));
    }

    function findNearestValidComputerPosition(target = null) {
        const placement = houseInterior.computerPlacement;
        const tested = new Set();
        const candidates = [];

        if (target) {
            candidates.push(clampInteriorPosition(target, placement.width, placement.height));
        }

        candidates.push(...getPreferredComputerLocations());

        if (target) {
            for (let radius = 16; radius <= 160; radius += 16) {
                for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 4) {
                    const candidate = {
                        x: target.x + Math.cos(angle) * radius,
                        y: target.y + Math.sin(angle) * radius
                    };
                    candidates.push(clampInteriorPosition(candidate, placement.width, placement.height));
                }
            }
        }

        for (const candidate of candidates) {
            if (!candidate) {
                continue;
            }
            const key = `${Math.round(candidate.x)}:${Math.round(candidate.y)}`;
            if (tested.has(key)) {
                continue;
            }
            tested.add(key);
            if (isInteriorComputerPlacementValid(candidate)) {
                return candidate;
            }
        }
        return null;
    }

    function tryPlaceInteriorComputer(position) {
        if (!position) {
            return { success: false, reason: "Invalid placement" };
        }
        if (!inventory?.hasStructureKit || !inventory?.consumeStructureKit) {
            return { success: false, reason: "Cannot use kits right now." };
        }
        if (!inventory.hasStructureKit("computer")) {
            return { success: false, reason: "Requires a computer kit." };
        }
        let targetPosition = position;
        if (!isInteriorComputerPlacementValid(targetPosition)) {
            targetPosition = findNearestValidComputerPosition(position);
        }
        if (!targetPosition) {
            return { success: false, reason: "Not enough space for the computer." };
        }
        if (!isInteriorComputerPlacementValid(targetPosition)) {
            return { success: false, reason: "Not enough space for the computer." };
        }
        const consumed = inventory.consumeStructureKit("computer");
        if (!consumed) {
            return { success: false, reason: "Computer kit missing." };
        }
        const placement = houseInterior.computerPlacement;
        const computer = {
            id: `computer-${Date.now().toString(36)}-${Math.floor(Math.random() * 4096)}`,
            position: {
                x: Math.round(targetPosition.x),
                y: Math.round(targetPosition.y)
            },
            width: placement.width,
            height: placement.height
        };
        houseInterior.computers.push(computer);
        return { success: true, computer };
    }

    const interiorState = {
        position: { ...houseInterior.spawn },
        speed: 140
    };

    resources.onDayStart(gameState.dayNumber);
    markResourcesDirty();
    loot.onDayStart(gameState.dayNumber);
    const initialResources = inventory.getResources();
    ui.updatePhase(gameState.dayNumber, gameState.phase, gameState.phaseTimer);
    refreshResourceUI(initialResources);
    updateVitalsUI();
    ui.showMessage("Gather resources with E, select kits with 1-8 to build, defend at night.", 4);

    launchIntroPulse();
    highlightDifficultyButtons(gameState.difficultyKey);

    if (difficultyButtons.length) {
        difficultyButtons.forEach((button) => {
            button.addEventListener("click", () => {
                const key = button.dataset.difficulty || DEFAULT_DIFFICULTY;
                if (pendingDifficultyIntent === "singleplayer" && gameState.awaitingDifficulty && !multiplayerState.lobbyId) {
                    beginGameWithDifficulty(key);
                } else if (pendingDifficultyIntent === "multiplayer" && multiplayerState.lobbyId) {
                    updateDifficultySelection(key, { broadcast: true });
                    showStartPanel("multiplayer");
                } else {
                    updateDifficultySelection(key);
                    showStartPanel("menu");
                }
            });
        });
    } else {
        gameState.paused = false;
        gameState.awaitingDifficulty = false;
    }

    if (restartButton) {
        restartButton.addEventListener("click", () => {
            window.location.reload();
        });
    }
    if (computerCloseButton) {
        computerCloseButton.addEventListener("click", () => {
            closeComputerOverlay();
        });
    }
    if (computerOverlay) {
        computerOverlay.addEventListener("click", (event) => {
            const target = event.target;
            if (target === computerOverlay || (target instanceof Element && target.classList.contains("computer-overlay__backdrop"))) {
                closeComputerOverlay();
            }
        });
    }


    let lastTimestamp = performance.now();

    function launchIntroPulse() {
        effects.spawnPulse({
            position: { ...world.house.position },
            startRadius: 40,
            endRadius: 160,
            color: "rgba(128, 199, 255, 0.35)"
        });
    }



function updateVitalsUI() {
    if (ui?.updateVitals) {
        ui.updateVitals({
            playerHealth: player.health,
            playerMaxHealth: player.maxHealth,
            houseHealth: world.house.hp,
            houseMaxHealth: world.house.maxHp,
            damageFlash: gameState.playerDamageFlash ?? 0
        });
    } else if (ui?.updateHouse) {
        updateVitalsUI();
    }
    gameState.lastPlayerHealth = player.health;
    gameState.lastPlayerMaxHealth = player.maxHealth;
}

function highlightDifficultyButtons(key) {
    difficultyButtons.forEach((button) => {
        const isActive = button.dataset.difficulty === key;
        button.classList.toggle("active", isActive);
        button.setAttribute("aria-pressed", isActive ? "true" : "false");
    });
}

function applyDifficultySettings(key = DEFAULT_DIFFICULTY) {
    const fallback = DIFFICULTY_PRESETS[DEFAULT_DIFFICULTY] ?? DIFFICULTY_PRESETS.normal;
    const selected = DIFFICULTY_PRESETS[key] ?? fallback;
    gameState.difficultyKey = selected.key;
    gameState.difficultySettings = selected;
    player.applyDifficulty({
        playerHealth: selected.playerHealth,
        playerDamageMultiplier: selected.playerDamageMultiplier,
        baseDamageReduction: selected.baseDamageReduction,
        gatherMultiplier: selected.gatherMultiplier ?? 1
    });
    player.health = player.maxHealth;
    resources.resourceYieldMultiplier = selected.resourceYieldMultiplier ?? 1;
    loot.setModifiers({
        lootQualityModifier: selected.lootQualityModifier ?? 1,
        resourceYield: selected.resourceYieldMultiplier ?? 1
    });
    enemyWaves.configureDifficulty({
        enemyDamageMultiplier: selected.enemyDamageMultiplier ?? 1,
        enemyHealthMultiplier: selected.enemyHealthMultiplier ?? 1,
        enemySpeedMultiplier: selected.enemySpeedMultiplier ?? 1,
        spawnMultiplier: selected.spawnMultiplier ?? 1
    });
    gameState.lastPlayerHealth = player.health;
    gameState.lastPlayerMaxHealth = player.maxHealth;
    highlightDifficultyButtons(selected.key);
    refreshResourceUI();
    updateVitalsUI();
    return selected;
}

function beginGameWithDifficulty(key) {
    const applied = applyDifficultySettings(key);
    loot.generateInitialChests();
    if (startOverlay) {
        startOverlay.classList.add("dismissed");
        startOverlay.setAttribute("aria-hidden", "true");
    }
    gameState.paused = false;
    gameState.awaitingDifficulty = false;
    updatePauseButtonState();
    ui.showMessage(applied.label + " difficulty engaged. Good luck!", 3, "#7be0a6");
    if (canvas) {
        canvas.focus({ preventScroll: true });
    }
}

function presentGameOver() {
    if (pauseOverlay) {
        pauseOverlay.classList.remove("open");
        pauseOverlay.setAttribute("aria-hidden", "true");
        pauseOverlay.setAttribute("inert", "");
    }
    gameState.pauseMenuOpen = false;
    if (gameOverOverlay) {
        gameOverOverlay.classList.add("open");
        gameOverOverlay.setAttribute("aria-hidden", "false");
    }
    if (restartButton) {
        restartButton.focus({ preventScroll: true });
    }
    gameState.paused = true;
    updatePauseButtonState();
}

function refreshResourceUI(resourcesSnapshot) {
    const snapshot = resourcesSnapshot ?? inventory.getResources();
    ui.updateResources(snapshot);

    const selection = input.buildSelection || null;
    if (gameState.currentBuildSelection !== selection) {
        gameState.currentBuildSelection = selection;
    }

    const kitCounts = inventory.getStructureKitCounts
        ? inventory.getStructureKitCounts(CRAFTABLE_STRUCTURES)
        : {};
    ui.updateBuildSelection(gameState.currentBuildSelection, snapshot, kitCounts);

    const items = inventory.getItems();
    syncActiveInventorySelection(items);
    const equippedDetails = {};
    if (typeof inventory.getEquippedItem === "function") {
        const equippedArmor = inventory.getEquippedItem("armor");
        if (equippedArmor) {
            equippedDetails.armor = equippedArmor;
        }
    }
    ui.setInventoryData(snapshot, items, inventory.getCapacity(), {
        selectedIndex: gameState.selectedInventoryIndex,
        equipped: equippedDetails
    });

    if (gameState.craftingOpen) {
        refreshCraftingMenu();
    }
}

function consumeBerry() {
    if (!inventory?.consumeStack) {
        return false;
    }
    const consumed = inventory.consumeStack(BERRY_STACK_KEY);
    if (!consumed) {
        ui.showMessage("No berries to eat.", 1.2, "#ff8888");
        return false;
    }
    const healAmount = Math.max(0, consumed.healAmount ?? 0);
    const healed = healAmount > 0 ? player.heal(healAmount) : 0;
    if (healed > 0) {
        effects?.spawnFloatingText?.({
            text: `+${healed} HP`,
            position: { ...player.position },
            color: "#ffd6a5"
        });
        effects?.spawnPulse?.({
            position: { ...player.position },
            startRadius: 16,
            endRadius: 72,
            color: "rgba(255, 214, 165, 0.32)"
        });
        updateVitalsUI();
    }
    ui.showMessage(healed > 0 ? `Ate berries (+${healed} HP).` : "Ate berries.", 1.4, "#ffd6a5");
    refreshResourceUI();
    return true;
}

    function syncBuildSelectionForItem(item) {
        if (item?.category === "structure-kit" && item.structureType) {
            input.buildSelection = item.structureType;
        } else {
            input.buildSelection = null;
        }
    }

    function clearActiveInventorySelection({ silent = false } = {}) {
        let changed = false;
        if (gameState.selectedInventoryIndex !== -1) {
            gameState.selectedInventoryIndex = -1;
            changed = true;
        }
        if (input.buildSelection) {
            input.buildSelection = null;
            changed = true;
        }
        clearManagedEquippedSlots();
        changed = true;
        if (changed && !silent) {
            refreshResourceUI();
        }
    }

    function clearManagedEquippedSlots(exceptSlot = null) {
        const managedSlots = ["weapon", "tool"];
        for (const slot of managedSlots) {
            if (slot === exceptSlot) {
                continue;
            }
            if (typeof inventory.clearEquippedSlot === "function") {
                inventory.clearEquippedSlot(slot);
            } else if (typeof inventory.markEquippedSlot === "function") {
                inventory.markEquippedSlot(slot, -1);
            }
            if (player?.clearEquipmentSlot) {
                player.clearEquipmentSlot(slot);
            }
        }
    }

    function applySelectedEquipment(index, items) {
        if (!Number.isFinite(index) || index < 0) {
            return;
        }
        const list = Array.isArray(items) ? items : inventory.getItems();
        if (!Array.isArray(list) || !list[index]) {
            return;
        }
        const selected = list[index];
        if (!selected || selected.category !== "equipment" || !selected.slot) {
            clearManagedEquippedSlots();
            return;
        }
        const slotType = selected.slot;
        let appliedSlot = slotType;
        let shouldEquip = true;
        const liveItem = typeof inventory.getItemAt === "function"
            ? inventory.getItemAt(index)
            : (Array.isArray(inventory.items) ? inventory.items[index] : selected);
        const preserveSlot = slotType === "weapon" || slotType === "tool" ? slotType : null;
        clearManagedEquippedSlots(preserveSlot);
        if (player?.applyEquipment) {
            const applied = player.applyEquipment(liveItem || selected, { force: true });
            if (applied?.slot) {
                appliedSlot = applied.slot;
                shouldEquip = Boolean(applied.equipped);
            }
        }
        if (inventory?.markEquippedSlot && appliedSlot) {
            inventory.markEquippedSlot(appliedSlot, shouldEquip ? index : -1);
        }
        if (!shouldEquip && appliedSlot && player?.clearEquipmentSlot) {
            player.clearEquipmentSlot(appliedSlot);
        }
    }

    function setActiveInventoryIndex(index, { items, silent = false } = {}) {
        const list = Array.isArray(items) ? items : inventory.getItems();
        if (!Array.isArray(list) || !list.some(Boolean)) {
            clearActiveInventorySelection({ silent });
            return;
        }
        if (!Number.isFinite(index) || index < 0 || index >= list.length) {
            clearActiveInventorySelection({ silent });
            return;
        }
        if (!list[index]) {
            clearActiveInventorySelection({ silent });
            return;
        }
        gameState.selectedInventoryIndex = index;
        applySelectedEquipment(index, list);
        syncBuildSelectionForItem(list[index]);
        if (!silent) {
            refreshResourceUI();
        }
    }

    function syncActiveInventorySelection(items) {
        if (!Array.isArray(items) || !items.some(Boolean)) {
            clearActiveInventorySelection({ silent: true });
            return;
        }
        let index = gameState.selectedInventoryIndex;
        if (!Number.isFinite(index) || index < 0) {
            syncBuildSelectionForItem(null);
            return;
        }
        if (index >= items.length || !items[index]) {
            let fallback = -1;
            for (let i = Math.min(index, items.length - 1); i >= 0; i -= 1) {
                if (items[i]) {
                    fallback = i;
                    break;
                }
            }
            if (fallback === -1) {
                fallback = items.findIndex(Boolean);
            }
            if (fallback === -1) {
                clearActiveInventorySelection({ silent: true });
                return;
            }
            index = fallback;
            gameState.selectedInventoryIndex = index;
        }
        syncBuildSelectionForItem(items[index]);
    }

    function stepActiveInventorySelection(step) {
        if (!Number.isFinite(step) || step === 0) {
            return;
        }
        const items = inventory.getItems();
        const occupied = [];
        for (let i = 0; i < items.length; i += 1) {
            if (items[i]) {
                occupied.push(i);
            }
        }
        if (!occupied.length) {
            clearActiveInventorySelection({ silent: true });
            return;
        }
        let index = gameState.selectedInventoryIndex;
        const direction = step > 0 ? 1 : -1;
        if (!Number.isFinite(index) || index < 0 || !items[index]) {
            index = direction > 0 ? occupied[0] : occupied[occupied.length - 1];
        } else {
            const currentPos = occupied.indexOf(index);
            if (currentPos === -1) {
                index = direction > 0 ? occupied[0] : occupied[occupied.length - 1];
            } else {
                let nextPos = currentPos + direction;
                if (nextPos < 0) {
                    nextPos = occupied.length - 1;
                } else if (nextPos >= occupied.length) {
                    nextPos = 0;
                }
                index = occupied[nextPos];
            }
        }
        setActiveInventoryIndex(index, { items, silent: true });
        refreshResourceUI();
    }

    function tryUseInventoryItem(item) {
        if (!item) {
            return false;
        }
        const stackKey = inventory.getStackKey ? inventory.getStackKey(item) : item.stackKey;
        if (stackKey === BERRY_STACK_KEY) {
            return consumeBerry();
        }
        return false;
    }

function handleInventoryItemUse(details) {
    if (!details) {
        return;
    }
    const { index, event } = details;
    if (!Number.isFinite(index) || index < 0) {
        return;
    }
    const items = inventory.getItems();
    const item = items[index];
    if (!item) {
        clearActiveInventorySelection();
        return;
    }
    const clickCount = Number.isFinite(event?.detail) ? event.detail : 1;
    setActiveInventoryIndex(index, { items, silent: true });
    const used = tryUseInventoryItem(item);
    if (!used && clickCount >= 2 && item.category !== "structure-kit") {
        ui.showMessage("That item can't be used now.", 1.2, "#d5dde8");
    }
    refreshResourceUI();
}

function handleInventoryReorder(details) {
    if (!details) {
        return;
    }
    const { fromIndex, toIndex, slotType, fromSlotType, fromEquippedIndex } = details;
    const sourceIsEquipment = typeof fromSlotType === "string" && fromSlotType.length > 0;
    const targetIsEquipment = typeof slotType === "string" && slotType.length > 0;
    const items = inventory.getItems();
    if (!Array.isArray(items)) {
        return;
    }

    let liveItem = null;
    if (sourceIsEquipment) {
        liveItem = typeof inventory.getEquippedItem === "function" ? inventory.getEquippedItem(fromSlotType) : null;
        if (!liveItem) {
            refreshResourceUI();
            return;
        }
    } else {
        if (!Number.isFinite(fromIndex) || fromIndex < 0 || fromIndex >= items.length) {
            return;
        }
        if (!items[fromIndex]) {
            return;
        }
        liveItem = typeof inventory.getItemAt === "function"
            ? inventory.getItemAt(fromIndex)
            : (Array.isArray(inventory.items) ? inventory.items[fromIndex] : items[fromIndex]);
        if (!liveItem) {
            return;
        }
    }

    if (targetIsEquipment) {
        if (sourceIsEquipment) {
            refreshResourceUI();
            return;
        }
        if (!liveItem || liveItem.category !== "equipment" || liveItem.slot !== slotType) {
            ui.showMessage(`Only ${slotType} gear can go there.`, 1.4, "#ff8888");
            refreshResourceUI();
            return;
        }
        if (player?.applyEquipment) {
            player.applyEquipment(liveItem, { force: true });
        }
        if (inventory?.markEquippedSlot) {
            inventory.markEquippedSlot(slotType, fromIndex);
        }
        gameState.selectedInventoryIndex = fromIndex;
        refreshResourceUI();
        return;
    }

    if (sourceIsEquipment) {
        const preferredIndex = Number.isFinite(toIndex) && toIndex >= 0
            ? toIndex
            : (Number.isFinite(fromEquippedIndex) ? fromEquippedIndex : null);
        let placement = null;
        if (typeof inventory.unequipToIndex === "function") {
            placement = inventory.unequipToIndex(fromSlotType, preferredIndex);
        } else if (typeof inventory.clearEquippedSlot === "function") {
            inventory.clearEquippedSlot(fromSlotType);
        }
        if (!placement || !placement.item) {
            ui.showMessage("Inventory is full.", 1.2, "#ff8888");
            refreshResourceUI();
            return;
        }
        if (player?.clearEquipmentSlot) {
            player.clearEquipmentSlot(fromSlotType);
        }
        gameState.selectedInventoryIndex = placement.index;
        refreshResourceUI();
        return;
    }

    const capacity = items.length || inventory.getCapacity();
    const clampedTarget = Number.isFinite(toIndex)
        ? Math.max(0, Math.min(toIndex, capacity - 1))
        : fromIndex;
    const destinationHadItem = Boolean(items[clampedTarget]);
    const movedIndex = inventory.moveItem(fromIndex, clampedTarget);
    if (movedIndex === -1) {
        return;
    }

    if (gameState.selectedInventoryIndex !== -1) {
        const selected = gameState.selectedInventoryIndex;
        if (selected === fromIndex) {
            gameState.selectedInventoryIndex = movedIndex;
        } else if (destinationHadItem && selected === clampedTarget) {
            gameState.selectedInventoryIndex = fromIndex;
        }
    }

    refreshResourceUI();
}

    function setSettingsTab(tabId = "info") {
        if (!settingsTabs.length) {
            return;
        }
        const availableIds = settingsTabs.map((button) => button.dataset.tab);
        const targetId = availableIds.includes(tabId) ? tabId : availableIds[0];
        settingsTabs.forEach((button) => {
            const isActive = button.dataset.tab === targetId;
            button.classList.toggle("active", isActive);
            button.setAttribute("aria-selected", isActive ? "true" : "false");
        });
        settingsPanels.forEach((panel) => {
            const isActive = panel.dataset.panel === targetId;
            panel.classList.toggle("active", isActive);
            panel.setAttribute("aria-hidden", isActive ? "false" : "true");
        });
    }

    const mobileControlState = {
        pointerId: null,
        centerX: 0,
        centerY: 0,
        radius: 0,
        active: false,
        sprintActive: false
    };
    const JOYSTICK_DEADZONE = 0.32;

    function resetJoystickVisual() {
        if (joystickThumb) {
            joystickThumb.style.transform = "translate(-50%, -50%)";
        }
    }

    function setTouchSprintActive(active) {
        const next = Boolean(active);
        if (mobileControlState.sprintActive === next) {
            return;
        }
        mobileControlState.sprintActive = next;
        if (typeof input.setTouchSprint === "function") {
            input.setTouchSprint(next);
        } else {
            input.sprint = next;
        }
    }

    function clearTouchMovement() {
        if (typeof input.clearTouchMovement === "function") {
            input.clearTouchMovement();
        } else {
            input.up = false;
            input.down = false;
            input.left = false;
            input.right = false;
        }
    }

    function releaseJoystick() {
        if (mobileControlState.pointerId !== null && joystickBase?.hasPointerCapture?.(mobileControlState.pointerId)) {
            joystickBase.releasePointerCapture(mobileControlState.pointerId);
        }
        mobileControlState.pointerId = null;
        mobileControlState.active = false;
        mobileControlState.radius = 0;
        mobileControlState.centerX = 0;
        mobileControlState.centerY = 0;
        resetJoystickVisual();
        clearTouchMovement();
    }

    function applyJoystickMovement(clientX, clientY) {
        const { centerX, centerY, radius } = mobileControlState;
        if (!mobileControlState.active || radius <= 0) {
            return;
        }
        const dx = clientX - centerX;
        const dy = clientY - centerY;
        const distance = Math.hypot(dx, dy);
        const clampedDistance = Math.min(distance, radius);
        const angle = distance > 0 ? Math.atan2(dy, dx) : 0;
        const offsetX = Math.cos(angle) * clampedDistance;
        const offsetY = Math.sin(angle) * clampedDistance;
        if (joystickThumb) {
            joystickThumb.style.transform = `translate(-50%, -50%) translate(${offsetX}px, ${offsetY}px)`;
        }
        const normalizedX = radius > 0 ? offsetX / radius : 0;
        const normalizedY = radius > 0 ? offsetY / radius : 0;
        const threshold = JOYSTICK_DEADZONE;
        const nextState = {
            left: normalizedX < -threshold,
            right: normalizedX > threshold,
            up: normalizedY < -threshold,
            down: normalizedY > threshold
        };
        if (typeof input.setTouchMovement === "function") {
            input.setTouchMovement(nextState);
        } else {
            input.up = nextState.up;
            input.down = nextState.down;
            input.left = nextState.left;
            input.right = nextState.right;
        }
    }

    function handleJoystickPointerDown(event) {
        if (!gameState.mobileControlsEnabled || !joystickBase) {
            return;
        }
        event.preventDefault();
        mobileControlState.active = true;
        const rect = joystickBase.getBoundingClientRect();
        mobileControlState.pointerId = event.pointerId;
        mobileControlState.centerX = rect.left + rect.width / 2;
        mobileControlState.centerY = rect.top + rect.height / 2;
        mobileControlState.radius = Math.min(rect.width, rect.height) / 2;
        if (joystickBase.setPointerCapture) {
            joystickBase.setPointerCapture(event.pointerId);
        }
        applyJoystickMovement(event.clientX, event.clientY);
    }

    function handleJoystickPointerMove(event) {
        if (!mobileControlState.active || event.pointerId !== mobileControlState.pointerId) {
            return;
        }
        event.preventDefault();
        applyJoystickMovement(event.clientX, event.clientY);
    }

    function handleJoystickPointerEnd(event) {
        if (event.pointerId !== mobileControlState.pointerId) {
            return;
        }
        event.preventDefault();
        releaseJoystick();
    }

    function setMobileControlsEnabled(enabled, options = {}) {
        const { updateToggle = true, resetTouch = true } = options;
        const next = Boolean(enabled);
        const changed = next !== gameState.mobileControlsEnabled;
        gameState.mobileControlsEnabled = next;
        if (mobileControlsToggle && updateToggle) {
            mobileControlsToggle.checked = next;
        }
        if (mobileControlsRoot) {
            mobileControlsRoot.classList.toggle("active", next);
            mobileControlsRoot.setAttribute("aria-hidden", next ? "false" : "true");
        }
        if (!next && resetTouch) {
            releaseJoystick();
            setTouchSprintActive(false);
        }
        if (next) {
            clearTouchMovement();
            resetJoystickVisual();
            if (resetTouch) {
                setTouchSprintActive(false);
            }
        }
    }

    function openSettings(tabId = "info") {
        if (!settingsModal) {
            return;
        }
        setSettingsTab(tabId);
        if (mobileControlsToggle) {
            mobileControlsToggle.checked = gameState.mobileControlsEnabled;
        }
        settingsModal.removeAttribute("inert");
        settingsModal.classList.add("open");
        settingsModal.setAttribute("aria-hidden", "false");
        gameState.settingsOpen = true;
        gameState.paused = true;
        const activeTab = settingsModal.querySelector(".settings-tab.active");
        if (activeTab instanceof HTMLElement) {
            activeTab.focus({ preventScroll: true });
        }
    }

    function closeSettings() {
        if (!gameState.settingsOpen) {
            return;
        }
        if (settingsModal) {
            settingsModal.classList.remove("open");
            settingsModal.setAttribute("aria-hidden", "true");
            settingsModal.setAttribute("inert", "");
        }
        gameState.settingsOpen = false;
        if (gameState.pauseMenuOpen) {
            if (pauseResumeButton) {
                pauseResumeButton.focus({ preventScroll: true });
            }
        } else if (canvas) {
            canvas.focus({ preventScroll: true });
        }
    }

    function clearBuildSelection() {
        const hadSelection = Boolean(input.buildSelection || gameState.currentBuildSelection || gameState.selectedInventoryIndex !== -1);
        if (!hadSelection) {
            return;
        }
        input.buildSelection = null;
        gameState.currentBuildSelection = null;
        gameState.selectedInventoryIndex = -1;
        refreshResourceUI();
    }

    function openPauseMenu() {
        if (gameState.gameOver || gameState.pauseMenuOpen) {
            return;
        }
        gameState.pauseMenuOpen = true;
        gameState.paused = true;
        if (pauseOverlay) {
            pauseOverlay.removeAttribute("inert");
            pauseOverlay.classList.add("open");
            pauseOverlay.setAttribute("aria-hidden", "false");
        }
        if (pauseResumeButton) {
            pauseResumeButton.focus({ preventScroll: true });
        }
        if (gameState.craftingOpen) {
            closeCraftingMenu();
        }
        if (gameState.inventoryOpen) {
            gameState.inventoryOpen = false;
            ui.toggleInventory(false);
            refreshResourceUI();
        }
        clearBuildSelection();
        input.inventoryToggle = false;
        input.interact = false;
        input.attack = false;
        input.upgrade = false;
        input.mouse.clicked = false;
        updatePauseButtonState();
    }

    function closePauseMenu() {
        if (!gameState.pauseMenuOpen) {
            return;
        }
        closeSettings();
        if (pauseOverlay) {
            pauseOverlay.classList.remove("open");
            pauseOverlay.setAttribute("aria-hidden", "true");
            pauseOverlay.setAttribute("inert", "");
        }
        if (pauseResumeButton) {
            pauseResumeButton.blur();
        }
        if (canvas) {
            canvas.focus({ preventScroll: true });
        }
        gameState.pauseMenuOpen = false;
        gameState.paused = false;
        updatePauseButtonState();
    }

    function processPauseToggle() {
        if (!input.pauseToggle) {
            if (input.cancelPlacement) {
                input.cancelPlacement = false;
            }
            return;
        }

        const triggeredByEscape = input.cancelPlacement;
        input.pauseToggle = false;
        input.cancelPlacement = false;

        if (gameState.computerOverlayOpen) {
            closeComputerOverlay();
            return;
        }

        if (gameState.settingsOpen) {
            closeSettings();
            if (!gameState.pauseMenuOpen) {
                gameState.paused = false;
                updatePauseButtonState();
            }
            return;
        }

        if (triggeredByEscape) {
            if (gameState.craftingOpen) {
                closeCraftingMenu();
                return;
            }
            if (gameState.inventoryOpen) {
                gameState.inventoryOpen = false;
                ui.toggleInventory(false);
                refreshResourceUI();
                return;
            }
            if (gameState.currentBuildSelection || input.buildSelection) {
                clearBuildSelection();
                return;
            }
        }

        if (gameState.pauseMenuOpen) {
            closePauseMenu();
        } else {
            openPauseMenu();
        }
    }

    setSettingsTab();
    if (pauseResumeButton) {
        pauseResumeButton.addEventListener("click", () => {
            closePauseMenu();
        });
    }
    if (pauseSettingsButton) {
        pauseSettingsButton.addEventListener("click", () => {
            if (!gameState.pauseMenuOpen) {
                openPauseMenu();
            }
            openSettings("info");
        });
    }
    if (pauseRestartButton) {
        pauseRestartButton.addEventListener("click", () => {
            window.location.reload();
        });
    }
    if (pauseToggleButton) {
        pauseToggleButton.addEventListener("click", () => {
            if (pauseToggleButton.disabled) {
                return;
            }
            if (gameState.pauseMenuOpen) {
                closePauseMenu();
            } else {
                openPauseMenu();
            }
        });
    }
    if (pauseOverlay) {
        pauseOverlay.addEventListener("click", (event) => {
            if (event.target === pauseOverlay) {
                closePauseMenu();
            }
        });
    }
    if (settingsCloseButton) {
        settingsCloseButton.addEventListener("click", () => {
            closeSettings();
            if (!gameState.pauseMenuOpen) {
                gameState.paused = false;
                updatePauseButtonState();
            }
        });
    }
    if (settingsModal) {
        settingsModal.addEventListener("click", (event) => {
            if (event.target === settingsModal) {
                closeSettings();
                if (!gameState.pauseMenuOpen) {
                    gameState.paused = false;
                    updatePauseButtonState();
                }
            }
        });
    }
    settingsTabs.forEach((button) => {
        button.addEventListener("click", () => {
            setSettingsTab(button.dataset.tab);
        });
    });

    if (mobileControlsToggle) {
        mobileControlsToggle.addEventListener("change", () => {
            setMobileControlsEnabled(mobileControlsToggle.checked);
        });
    }

    if (joystickBase) {
        joystickBase.addEventListener("pointerdown", handleJoystickPointerDown);
        joystickBase.addEventListener("pointermove", handleJoystickPointerMove);
        joystickBase.addEventListener("pointerup", handleJoystickPointerEnd);
        joystickBase.addEventListener("pointercancel", handleJoystickPointerEnd);
        joystickBase.addEventListener("lostpointercapture", () => {
            releaseJoystick();
        });
    }

    mobileActionButtons.forEach((button) => {
        const action = button.dataset.action;
        if (!action) {
            return;
        }
        if (action === "sprint") {
            const stopSprint = (event) => {
                if (event && button.hasPointerCapture?.(event.pointerId)) {
                    button.releasePointerCapture(event.pointerId);
                }
                setTouchSprintActive(false);
            };
            button.addEventListener("pointerdown", (event) => {
                if (!gameState.mobileControlsEnabled) {
                    return;
                }
                event.preventDefault();
                if (button.setPointerCapture) {
                    button.setPointerCapture(event.pointerId);
                }
                setTouchSprintActive(true);
            });
            button.addEventListener("pointerup", stopSprint);
            button.addEventListener("pointercancel", stopSprint);
            button.addEventListener("pointerleave", stopSprint);
        } else {
            button.addEventListener("pointerdown", (event) => {
                if (!gameState.mobileControlsEnabled) {
                    return;
                }
                event.preventDefault();
                if (action === "attack") {
                    input.attack = true;
                } else if (action === "interact") {
                    input.interact = true;
                } else if (action === "inventory") {
                    input.inventoryToggle = true;
                }
            });
        }
    });

    setMobileControlsEnabled(gameState.mobileControlsEnabled, { updateToggle: true, resetTouch: false });

    function updateCamera() {
        if (gameState.inHouse) {
            gameState.camera.x = 0;
            gameState.camera.y = 0;
            input.mouse.worldX = input.mouse.x;
            input.mouse.worldY = input.mouse.y;
            return;
        }
        const targetX = player.position.x - CANVAS_WIDTH / 2;
        const targetY = player.position.y - CANVAS_HEIGHT / 2;
        const mapWidth = world.getWidth();
        const mapHeight = world.getHeight();
        gameState.camera.x = clamp(targetX, 0, Math.max(0, mapWidth - CANVAS_WIDTH));
        gameState.camera.y = clamp(targetY, 0, Math.max(0, mapHeight - CANVAS_HEIGHT));
        input.mouse.worldX = input.mouse.x + gameState.camera.x;
        input.mouse.worldY = input.mouse.y + gameState.camera.y;
    }

    function startNightPhase() {
        closeCraftingMenu();
        gameState.phase = "night";
        gameState.phaseTimer = NIGHT_LENGTH_SECONDS;
        enemyWaves.startWave(gameState.dayNumber);
        ui.showMessage(`Night ${gameState.dayNumber}: Enemies incoming!`, 3, "#ff6774");
        effects.spawnPulse({
            position: { ...world.house.position },
            startRadius: 30,
            endRadius: 260,
            color: "rgba(255, 102, 133, 0.35)"
        });
    }

    function startDayPhase() {
        closeCraftingMenu();
        gameState.dayNumber += 1;
        gameState.phase = "day";
        gameState.phaseTimer = DAY_LENGTH_SECONDS;

        let expandedThisMorning = false;
        if (
            gameState.dayNumber > 1 &&
            (gameState.dayNumber - 1) % MAP_EXPANSION_INTERVAL_DAYS === 0
        ) {
            const expansion = world.expand();
            if (expansion) {
                expandedThisMorning = true;
                loot.onMapExpanded();
                effects.spawnPulse({
                    position: { ...world.house.position },
                    startRadius: 200,
                    endRadius: 420,
                    color: "rgba(128, 199, 255, 0.28)"
                });
            }
        }

        resources.onDayStart(gameState.dayNumber);
        markResourcesDirty();
        loot.onDayStart(gameState.dayNumber);
        const dayMessageBase = `Day ${gameState.dayNumber}: Gather, build, prepare.`;
        const dayMessage = expandedThisMorning
            ? `${dayMessageBase} New territory unlocked.`
            : dayMessageBase;
        ui.showMessage(dayMessage, 3, "#7be0a6");
        effects.spawnPulse({
            position: { ...world.house.position },
            startRadius: 30,
            endRadius: expandedThisMorning ? 280 : 220,
            color: "rgba(123, 224, 166, 0.35)"
        });
    }

    function toggleInventory() {
        gameState.inventoryOpen = !gameState.inventoryOpen;
        ui.toggleInventory(gameState.inventoryOpen);
        refreshResourceUI();
    }


    function isInsideDoorZone(position, radius = houseInterior.door.radius) {
        const dx = position.x - houseInterior.door.position.x;
        const dy = position.y - houseInterior.door.position.y;
        return Math.hypot(dx, dy) <= radius;
    }

    function isInsideCraftingZone(position, radius = houseInterior.craftingTable.radius) {
        const dx = position.x - houseInterior.craftingTable.position.x;
        const dy = position.y - houseInterior.craftingTable.position.y;
        return Math.hypot(dx, dy) <= radius;
    }

    function updateHouseInteriorMovement(deltaSeconds) {
        let vx = 0;
        let vy = 0;
        if (input.up) vy -= 1;
        if (input.down) vy += 1;
        if (input.left) vx -= 1;
        if (input.right) vx += 1;
        const length = Math.hypot(vx, vy);
        if (length > 0) {
            vx /= length;
            vy /= length;
        }
        const speed = interiorState.speed;
        interiorState.position.x = clamp(
            interiorState.position.x + vx * speed * deltaSeconds,
            houseInterior.bounds.minX,
            houseInterior.bounds.maxX
        );
        interiorState.position.y = clamp(
            interiorState.position.y + vy * speed * deltaSeconds,
            houseInterior.bounds.minY,
            houseInterior.bounds.maxY
        );
    }

    function enterHouse() {
        if (gameState.inHouse) {
            return;
        }
        closeCraftingMenu();
        const doorPosition = world.getHouseDoorOutsidePosition();
        gameState.outsideReturnPosition = { x: player.position.x, y: player.position.y };
        interiorState.position = { ...houseInterior.spawn };
        gameState.inHouse = true;
        gameState.inventoryOpen = false;
        ui.toggleInventory(false);
        input.buildSelection = null;
        gameState.currentBuildSelection = null;
        ui.showMessage("You step inside the house.", 1.6, "#d5dde8");
        effects.spawnPulse({
            position: { ...doorPosition },
            startRadius: 18,
            endRadius: 90,
            color: "rgba(213, 221, 232, 0.35)"
        });
    }

    function exitHouse() {
        if (!gameState.inHouse) {
            return;
        }
        const doorPosition = world.getHouseDoorOutsidePosition();
        const fallback = { x: doorPosition.x, y: doorPosition.y + player.size };
        const target = gameState.outsideReturnPosition || fallback;
        player.position.x = target.x;
        player.position.y = target.y;
        closeCraftingMenu();
        closeComputerOverlay({ restoreFocus: false });
        gameState.inHouse = false;
        gameState.outsideReturnPosition = null;
        ui.showMessage("Back outside.", 1.4, "#d5dde8");
        input.mouse.clicked = false;
        effects.spawnPulse({
            position: { ...doorPosition },
            startRadius: 18,
            endRadius: 90,
            color: "rgba(213, 221, 232, 0.35)"
        });
    }


function buildCraftingMenuData() {
    const resourcesSnapshot = inventory.getResources();
    const kitCounts = inventory.getStructureKitCounts
        ? inventory.getStructureKitCounts(CRAFTABLE_STRUCTURES)
        : {};

    const options = CRAFTABLE_STRUCTURES.map((key) => {
        const blueprint = STRUCTURE_TYPES[key];
        const costEntries = Object.entries(blueprint.cost || {}).map(([resource, amount]) => ({
            resource,
            amount,
            affordable: (resourcesSnapshot[resource] ?? 0) >= amount
        }));
        let canCraft = costEntries.every((entry) => entry.affordable);
        const kitPrototype = {
            category: "structure-kit",
            structureType: key
        };
        const hasRoom = inventory.canAddItem
            ? inventory.canAddItem(kitPrototype)
            : inventory.hasFreeSlot
                ? inventory.hasFreeSlot()
                : inventory.getItems().some((slot) => !slot);
        let disabledReason = "";
        let note = "";
        if (!hasRoom) {
            canCraft = false;
            disabledReason = "Inventory full";
            note = "Inventory full";
        } else if (!canCraft) {
            disabledReason = "Not enough resources";
            note = "Not enough resources";
        }
        return {
            key,
            name: `${formatName(key)} Kit`,
            iconPath: STRUCTURE_ICON_PATHS[key],
            costEntries,
            canCraft,
            disabledReason,
            note,
            owned: kitCounts[key] ?? 0
        };
    });

    return {
        resources: resourcesSnapshot,
        options
}
}

function refreshCraftingMenu(force = false, dataOverride = null) {
    if (!gameState.craftingOpen) {
        return;
    }
    const menuData = dataOverride ?? buildCraftingMenuData();
    const signature = JSON.stringify(menuData);
    if (!force && signature === lastCraftingMenuSignature) {
        return;
    }
    lastCraftingMenuSignature = signature;
    ui.updateCraftingMenu(menuData);
}

function openCraftingMenu() {
    if (gameState.craftingOpen) {
        return;
    }
    if (gameState.inventoryOpen) {
        toggleInventory();
    }
    if (input.buildSelection) {
        input.buildSelection = null;
        gameState.currentBuildSelection = null;
    }
    gameState.craftingOpen = true;
    const menuData = buildCraftingMenuData();
    lastCraftingMenuSignature = JSON.stringify(menuData);
    ui.showCraftingMenu(menuData);
    refreshResourceUI();
    ui.showMessage("Select a kit to craft.", 1.4, "#d5dde8");
}

function closeCraftingMenu() {
    if (!gameState.craftingOpen) {
        return;
    }
    gameState.craftingOpen = false;
    ui.hideCraftingMenu();
    lastCraftingMenuSignature = null;
}

function openComputerOverlay() {
    if (!computerOverlay || gameState.computerOverlayOpen) {
        return;
    }
    computerOverlayPrevPaused = gameState.paused;
    computerOverlayReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    gameState.computerOverlayOpen = true;
    computerOverlay.classList.add("open");
    computerOverlay.setAttribute("aria-hidden", "false");
    if (!computerOverlayPrevPaused) {
        gameState.paused = true;
        updatePauseButtonState();
    }
    if (computerCloseButton) {
        computerCloseButton.focus({ preventScroll: true });
    }
}

function closeComputerOverlay(options = {}) {
    if (!computerOverlay || !gameState.computerOverlayOpen) {
        return;
    }
    computerOverlay.classList.remove("open");
    computerOverlay.setAttribute("aria-hidden", "true");
    gameState.computerOverlayOpen = false;
    if (!computerOverlayPrevPaused) {
        gameState.paused = false;
        updatePauseButtonState();
    }
    if (options.restoreFocus !== false) {
        const target = computerOverlayReturnFocus && computerOverlayReturnFocus.isConnected
            ? computerOverlayReturnFocus
            : canvas;
        if (target && typeof target.focus === "function") {
            target.focus({ preventScroll: true });
        }
    }
    computerOverlayReturnFocus = null;
}

function attemptCraftStructure(typeKey) {
    const blueprint = STRUCTURE_TYPES[typeKey];
    if (!blueprint) {
        return;
    }

    const kitItem = {
        id: `kit-${typeKey}-${Date.now()}`,
        name: `${formatName(typeKey)} Kit`,
        description: `Use to deploy a ${formatName(typeKey)}.`,
        category: "structure-kit",
        structureType: typeKey,
        iconPath: STRUCTURE_ICON_PATHS[typeKey],
        stackable: true
    };

    const canStoreKit = inventory.canAddItem
        ? inventory.canAddItem(kitItem)
        : inventory.hasFreeSlot
            ? inventory.hasFreeSlot()
            : inventory.getItems().some((slot) => !slot);
    if (!canStoreKit) {
        ui.showMessage("Inventory is full.", 1.6, "#ff8888");
        return;
    }

    if (!inventory.canAfford(blueprint.cost) || !inventory.spendResources(blueprint.cost)) {
        ui.showMessage("Not enough resources.", 1.6, "#ff8888");
        return;
    }

    if (!inventory.addItem(kitItem)) {
        inventory.refundResources(blueprint.cost);
        ui.showMessage("Inventory is full.", 1.6, "#ff8888");
        return;
    }

    ui.showMessage(`${kitItem.name} crafted!`, 1.6, "#7be0a6");
    effects.spawnPulse({
        position: { ...world.house.position },
        startRadius: 24,
        endRadius: 90,
        color: "rgba(132, 182, 255, 0.35)"
    });
    refreshResourceUI();
    if (gameState.craftingOpen) {
        refreshCraftingMenu(true);
    }
}


function handleInput(deltaSeconds) {
    if (gameState.computerOverlayOpen) {
        if (input.pauseToggle || input.cancelPlacement || input.interact) {
            closeComputerOverlay();
        }
        input.pauseToggle = false;
        input.cancelPlacement = false;
        input.interact = false;
        input.attack = false;
        input.upgrade = false;
        input.inventoryToggle = false;
        input.hotbarSelect = null;
        input.hotbarScroll = 0;
        input.consumeBerries = false;
        input.mouse.clicked = false;
        return;
    }

    if (input.hotbarSelect !== null) {
        const targetIndex = input.hotbarSelect;
        const items = inventory.getItems();
        let changed = false;
        if (targetIndex >= 0 && targetIndex < items.length) {
            setActiveInventoryIndex(targetIndex, { items, silent: true });
            changed = true;
        } else if (gameState.selectedInventoryIndex !== -1) {
            clearActiveInventorySelection({ silent: true });
            changed = true;
        }
        if (changed) {
            refreshResourceUI();
        }
        input.hotbarSelect = null;
    }

    if (input.hotbarScroll) {
        stepActiveInventorySelection(input.hotbarScroll > 0 ? 1 : -1);
        input.hotbarScroll = 0;
    }

    if (input.inventoryToggle) {
        if (gameState.craftingOpen) {
            closeCraftingMenu();
        } else {
            toggleInventory();
        }
        input.inventoryToggle = false;
    }

    if (gameState.craftingOpen) {
        if (input.interact) {
            closeCraftingMenu();
            input.interact = false;
        }
        input.attack = false;
        input.upgrade = false;
        return;
    }

    if (gameState.inHouse) {
        updateHouseInteriorMovement(deltaSeconds);

        const pointerInterior = canvasToInteriorPosition(input.mouse.worldX, input.mouse.worldY);
        const placementSpec = houseInterior.computerPlacement;
        const hasComputerSelection = input.buildSelection === "computer";

        if (hasComputerSelection && input.mouse.clicked) {
            const targetInterior = pointerInterior ?? interiorState.position;
            const result = tryPlaceInteriorComputer(targetInterior);
            if (result.success) {
                ui.showMessage("Computer installed inside the house.", 1.6, "#7be0a6");
                if (!inventory?.hasStructureKit || !inventory.hasStructureKit("computer")) {
                    input.buildSelection = null;
                    gameState.currentBuildSelection = null;
                }
                refreshResourceUI();
            } else if (result.reason) {
                ui.showMessage(result.reason, 1.4, "#ff8888");
            }
            input.mouse.clicked = false;
        } else if (input.mouse.clicked) {
            input.mouse.clicked = false;
        }

        if (input.interact) {
            const nearbyComputer = findInteriorComputerNear(interiorState.position);
            const nearTable = isInsideCraftingZone(interiorState.position);
            const nearDoor = isInsideDoorZone(interiorState.position);
            if (nearbyComputer) {
                openComputerOverlay();
            } else if (nearTable) {
                openCraftingMenu();
            } else if (nearDoor) {
                exitHouse();
            } else {
                ui.showMessage("Step to the door to leave or the table to craft.", 1.3, "#d5dde8");
            }
            input.interact = false;
        }
        if (input.upgrade) {
            input.upgrade = false;
        }
        if (input.attack) {
            input.attack = false;
        }
        if (input.buildSelection && input.buildSelection !== "computer") {
            input.buildSelection = null;
            gameState.currentBuildSelection = null;
            refreshResourceUI();
        }
        playerVelocity.x = 0;
        playerVelocity.y = 0;
        lastPlayerPosition.x = player.position.x;
        lastPlayerPosition.y = player.position.y;
        return;
    }

    if (gameState.gameOver) {
        player.update(0, input);
        playerVelocity.x = 0;
        playerVelocity.y = 0;
        lastPlayerPosition.x = player.position.x;
        lastPlayerPosition.y = player.position.y;
        return;
    }

    player.update(deltaSeconds, input);
    if (deltaSeconds > 0) {
        playerVelocity.x = (player.position.x - lastPlayerPosition.x) / deltaSeconds;
        playerVelocity.y = (player.position.y - lastPlayerPosition.y) / deltaSeconds;
    } else {
        playerVelocity.x = 0;
        playerVelocity.y = 0;
    }
    lastPlayerPosition.x = player.position.x;
    lastPlayerPosition.y = player.position.y;

    if (input.interact) {
        // If there's a nearby structure, prefer upgrading it when interacting (helps mobile users)
        const nearbyStructureForUpgrade = structures.findStructureNear(player.position);
        if (nearbyStructureForUpgrade) {
            const result = structures.attemptUpgrade(nearbyStructureForUpgrade, inventory);
            if (result.success) {
                ui.showMessage(`${nearbyStructureForUpgrade.typeKey} upgraded to Lv.${nearbyStructureForUpgrade.level}`, 2, "#84b6ff");
                refreshResourceUI();
                effects.spawnPulse({
                    position: { ...nearbyStructureForUpgrade.position },
                    startRadius: 16,
                    endRadius: 64,
                    color: "rgba(132, 182, 255, 0.4)"
                });
            } else if (result.reason) {
                ui.showMessage(result.reason, 2, "#ff8888");
            }
            input.interact = false;
            return;
        }

        if (world.isNearHouseDoor(player.position, world.house.door.radius * 0.85)) {
            enterHouse();
            input.interact = false;
            return;
        }
        const nearbyChest = loot.findNearby(player.position);
        if (nearbyChest) {
            const rewards = loot.openChest(nearbyChest, { inventory, player, ui, effects });
            let needsRefresh = false;
            if (Array.isArray(rewards)) {
                for (const reward of rewards) {
                    if (reward?.kind === "resource" || reward?.kind === "berry") {
                        needsRefresh = true;
                    }
                    if (reward?.kind === "kit") {
                        needsRefresh = true;
                    }
                    if (reward?.kind === "equipment") {
                        if (reward.added) {
                            needsRefresh = true;
                        } else {
                            ui.showMessage("Inventory full. Equipment could not be stored.", 2, "#ff8888");
                        }
                        if (reward.applied?.equipped) {
                            const slotLabel = reward.item.slot === "weapon"
                                ? "Weapon equipped"
                                : reward.item.slot === "armor"
                                    ? "Armor equipped"
                                    : "Tool equipped";
                            effects?.spawnFloatingText?.({
                                text: slotLabel,
                                position: { ...player.position },
                                color: "#ffd166"
                            });
                        }
                    }
                    if (reward?.kind === "kit-denied") {
                        ui.showMessage("Inventory full. Make space before looting kits.", 2, "#ff8888");
                    }
                    if (reward?.kind === "item-denied") {
                        ui.showMessage("Inventory full. Consumables could not be stored.", 2, "#ff8888");
                    }
                }
            }
            if (needsRefresh) {
                refreshResourceUI();
            }
            input.interact = false;
            return;
        }

        const gathered = resources.attemptGather(player);
        if (gathered) {
            if (!gathered.failureReason) {
                markResourcesDirty();
                broadcastResourceNodeUpdate(gathered);
            }
            if (gathered.rewarded) {
                const amountLabel = `${gathered.rewardAmount} ${formatName(gathered.type)}`;
                let message = `+${amountLabel}`;
                let messageColor = "#7be0a6";
                let floatText = `+${gathered.rewardAmount}`;
                let floatColor = "#7be0a6";
                refreshResourceUI();
                if (gathered.type === "berries") {
                    message = `Stored ${amountLabel}`;
                    floatText = `+${amountLabel}`;
                    floatColor = "#ffd6a5";
                    messageColor = "#ffd6a5";
                    if (!gameState.berryHintShown) {
                        message = `Stored ${amountLabel}. Press H or click the stack to eat.`;
                        gameState.berryHintShown = true;
                    }
                }
                ui.showMessage(message, 1.6, messageColor);
                effects.spawnFloatingText({
                    text: floatText,
                    position: { ...gathered.position },
                    color: floatColor
                });
                effects.spawnPulse({
                    position: gathered.position,
                    startRadius: 12,
                    endRadius: 54,
                    color: gathered.type === "berries" ? "rgba(255, 214, 165, 0.4)" : "rgba(123, 224, 166, 0.45)"
                });
            } else if (gathered.failureReason === "inventory-full") {
                const color = gathered.type === "berries" ? "#ff8888" : "#ff8888";
                const label = gathered.type === "berries"
                    ? "Inventory full. Make space before gathering more berries."
                    : "Inventory full.";
                ui.showMessage(label, 1.6, color);
            } else {
                const progressPercent = Math.min(99, Math.round((gathered.progress ?? 0) * 100));
                ui.showMessage(`Harvesting ${formatName(gathered.type)} (${progressPercent}%)`, 0.8, "#b4c6dd");
            }
        } else {
            ui.showMessage("Nothing to gather here.", 1.2, "#ff8888");
        }
        input.interact = false;
    }

    if (input.consumeBerries) {
        consumeBerry();
        input.consumeBerries = false;
    }

    if (input.upgrade) {
        const target = structures.findStructureNear(player.position);
        if (target) {
            const result = structures.attemptUpgrade(target, inventory);
            if (result.success) {
                ui.showMessage(`${target.typeKey} upgraded to Lv.${target.level}`, 2, "#84b6ff");
                refreshResourceUI();
                effects.spawnPulse({
                    position: { ...target.position },
                    startRadius: 16,
                    endRadius: 64,
                    color: "rgba(132, 182, 255, 0.4)"
                });
            } else if (result.reason) {
                ui.showMessage(result.reason, 2, "#ff8888");
            }
        } else {
            ui.showMessage("No structure nearby to upgrade.", 1.5, "#ff8888");
        }
        input.upgrade = false;
    }

    const canTriggerMouseAction = !input.buildSelection
        && !gameState.inventoryOpen
        && !gameState.craftingOpen
        && !gameState.pauseMenuOpen
        && !gameState.inHouse
        && !gameState.gameOver;

    if (canTriggerMouseAction && input.mouse.clicked) {
        const gatherableNode = resources.findGatherableNode(player);
        const nearbyChest = loot.findNearby(player.position);
        const pointerX = Number.isFinite(input.mouse.worldX) ? input.mouse.worldX : player.position.x;
        const pointerY = Number.isFinite(input.mouse.worldY) ? input.mouse.worldY : player.position.y;
        let shouldInteract = false;

        if (gatherableNode) {
            const distanceToNode = Math.hypot(pointerX - gatherableNode.position.x, pointerY - gatherableNode.position.y);
            if (distanceToNode <= 80) {
                shouldInteract = true;
            }
        }

        if (!shouldInteract && nearbyChest) {
            const distanceToChest = Math.hypot(pointerX - nearbyChest.position.x, pointerY - nearbyChest.position.y);
            if (distanceToChest <= 96) {
                shouldInteract = true;
            }
        }

        if (shouldInteract) {
            input.interact = true;
        } else {
            input.attack = true;
        }
        input.mouse.clicked = false;
    }

    if (input.attack && player.canAttack()) {
        if (multiplayerState.lobbyId && !multiplayerState.isHost && multiplayerInstance) {
            const targets = player.collectAttackTargets(enemyWaves.enemies);
            player.applyAttackAnimation(targets.length);
            if (targets.length) {
                const enemyIds = targets
                    .map((enemy) => Number.isFinite(enemy?.id) ? enemy.id : null)
                    .filter((id) => Number.isFinite(id));
                if (enemyIds.length) {
                    emitMultiplayerEvent("combat:attack", {
                        enemyIds,
                        damage: player.getAttackDamage()
                    });
                }
            }
        } else {
            const hits = player.performAttack(enemyWaves.enemies);
            if (hits.length > 0) {
                hits.forEach((hit) => {
                    const damageText = `-${hit.damage}`;
                    effects.spawnFloatingText({
                        text: damageText,
                        position: { ...hit.enemy.position },
                        color: "#ffd166"
                    });
                    if (hit.killed) {
                        effects.spawnFloatingText({
                            text: "Down!",
                            position: { x: hit.enemy.position.x, y: hit.enemy.position.y - 26 },
                            color: "#ff8ba7"
                        });
                    }
                });
                ui.showMessage(`Hit ${hits.length} enemy (${player.getAttackDamage()} dmg)`, 1, "#ffd166");
            }
        }
        input.attack = false;
    }

    if (input.rotatePlacement && !gameState.rotateLatch) {
        gameState.placementRotation += Math.PI / 2;
        gameState.rotateLatch = true;
    }
    if (!input.rotatePlacement) {
        gameState.rotateLatch = false;
    }

    if (input.buildSelection && input.mouse.clicked && !gameState.inventoryOpen && !gameState.craftingOpen && !gameState.inHouse) {
        const typeKey = input.buildSelection;
        if (typeKey === "computer") {
            ui.showMessage("Computers must be installed inside the house.", 1.6, "#ff8888");
            input.mouse.clicked = false;
            return;
        }
        const blueprint = STRUCTURE_TYPES[typeKey];
        if (blueprint) {
            const position = { x: input.mouse.worldX, y: input.mouse.worldY };
            const result = structures.attemptPlacement(typeKey, position, inventory, gameState.placementRotation);
            if (result.success) {
                ui.showMessage(`${formatName(typeKey)} placed`, 1.5, "#7be0a6");
                refreshResourceUI();
                effects.spawnPulse({
                    position,
                    startRadius: 12,
                    endRadius: 72,
                    color: "rgba(123, 224, 166, 0.5)"
                });
            } else if (result.reason) {
                ui.showMessage(result.reason, 1.5, "#ff8888");
            }
        }
        input.mouse.clicked = false;
    } else if (input.buildSelection && input.mouse.clicked) {
        input.mouse.clicked = false;
    }
}

function updateGame(deltaSeconds) {
        processPauseToggle();
        updateCamera();
        gameState.playerDamageFlash = Math.max(0, gameState.playerDamageFlash - deltaSeconds);

        if (gameState.gameOver) {
            effects.update(deltaSeconds);
            return;
        }

        if (gameState.paused) {
            return;
        }

        if (gameState.awaitingDifficulty) {
            return;
        }

        handleInput(deltaSeconds);
        updateCamera();

        gameState.phaseTimer = Math.max(0, gameState.phaseTimer - deltaSeconds);

        if (gameState.phase === "day" && gameState.phaseTimer <= 0) {
            startNightPhase();
        }

        // Run enemy spawning/updates when in singleplayer (no lobby) or when this client is the host.
        // If connected to a multiplayer lobby and not the host, skip authoritative enemy updates.
        const shouldRunEnemies = !multiplayerState.lobbyId || multiplayerState.isHost || !multiplayerInstance;
        const enemyEvents = shouldRunEnemies
            ? enemyWaves.update(deltaSeconds, world, structures, inventory, effects, player, gameState.phase === "night")
            : simulateRemoteEnemyBehavior();
        if (shouldRunEnemies) {
            processPendingRemoteAttacks();
        }
        structures.update(deltaSeconds, enemyWaves.enemies, effects);
        effects.update(deltaSeconds);

        const playerHits = enemyEvents?.playerHits ?? [];
        if (playerHits.length) {
            let totalDamage = 0;
            for (const hit of playerHits) {
                const damage = Math.round(hit.damage ?? 0);
                totalDamage += damage;
                if (damage > 0) {
                    effects.spawnFloatingText({
                        text: `-${damage} HP`,
                        position: { ...player.position },
                        color: "#ff6b6b"
                    });
                }
            }
            if (totalDamage > 0) {
                ui.showMessage(`Took ${totalDamage} damage!`, 1.4, "#ff6b6b");
                effects.spawnPulse({
                    position: { ...player.position },
                    startRadius: 10,
                    endRadius: 84,
                    color: "rgba(255, 107, 107, 0.35)"
                });
            }
            gameState.playerDamageFlash = 0.3;
        }

        if (!player.isAlive() && !gameState.gameOver) {
            gameState.gameOver = true;
            ui.showMessage("You were overwhelmed!", 4, "#ff4d6d");
            gameState.inventoryOpen = false;
            ui.toggleInventory(false);
            presentGameOver();
        }

        if (gameState.phase === "night" && !enemyWaves.active) {
            startDayPhase();
        }

        if (world.house.hp <= 0 && !gameState.gameOver) {
            gameState.gameOver = true;
            ui.showMessage("House destroyed!", 6, "#ff4d6d");
            gameState.inventoryOpen = false;
            ui.toggleInventory(false);
            presentGameOver();
        }

        updateVitalsUI();
        refreshResourceUI();

        const phaseMetric = gameState.phase === "day"
            ? Math.max(0, gameState.phaseTimer)
            : enemyWaves.toSpawn + enemyWaves.enemies.length;
        ui.updatePhase(gameState.dayNumber, gameState.phase, phaseMetric);
    }

    function drawBuildGhost() {
        if (!input.buildSelection || gameState.inventoryOpen || gameState.craftingOpen || gameState.inHouse) return;
        if (input.buildSelection === "computer") return;
        const blueprint = STRUCTURE_TYPES[input.buildSelection];
        if (!blueprint) return;
        const position = { x: input.mouse.worldX, y: input.mouse.worldY };
        const hasKit = inventory.hasStructureKit ? inventory.hasStructureKit(input.buildSelection) : true;
        const validSpot = structures.isPlacementValid(input.buildSelection, position);
        ctx.save();
        ctx.globalAlpha = 0.45;
        ctx.fillStyle = hasKit && validSpot ? "#8be78b" : "#ff6b6b";
        ctx.translate(position.x - gameState.camera.x, position.y - gameState.camera.y);
        if (input.buildSelection === "turret") {
            ctx.rotate(gameState.placementRotation);
        }
        ctx.fillRect(-blueprint.size / 2, -blueprint.size / 2, blueprint.size, blueprint.size);
        ctx.restore();
    }


    function drawMinimap() {
        const config = minimapConfig;
        const width = config.width;
        const height = config.height;
        const x = CANVAS_WIDTH - width - config.margin;
        const y = CANVAS_HEIGHT - height - config.margin;
        const mapWidth = world.getWidth();
        const mapHeight = world.getHeight();
        const scaleX = width / mapWidth;
        const scaleY = height / mapHeight;
        const minPlotX = x + 3;
        const maxPlotX = x + width - 3;
        const minPlotY = y + 3;
        const maxPlotY = y + height - 3;

        const projectX = (value) => Math.min(maxPlotX, Math.max(minPlotX, x + value * scaleX));
        const projectY = (value) => Math.min(maxPlotY, Math.max(minPlotY, y + value * scaleY));

        ctx.save();
        ctx.fillStyle = gameState.phase === "night" ? config.backgroundNight : config.backgroundDay;
        ctx.fillRect(x, y, width, height);

        ctx.strokeStyle = config.border;
        ctx.lineWidth = 2;
        ctx.strokeRect(x, y, width, height);

        for (const node of resources.nodes) {
            const px = projectX(node.position.x);
            const py = projectY(node.position.y);
            const color = config.resourceColors[node.type] || "#cbd5e1";
            ctx.fillStyle = node.amount > 0 ? color : "rgba(90, 100, 110, 0.4)";
            ctx.fillRect(px - 2, py - 2, 4, 4);
        }

        for (const chest of loot.chests) {
            const px = projectX(chest.position.x);
            const py = projectY(chest.position.y);
            ctx.fillStyle = chest.opened ? "rgba(224, 180, 95, 0.35)" : "#e0b45f";
            ctx.fillRect(px - 2, py - 2, 4, 4);
        }

        for (const structure of structures.structures) {
            const px = projectX(structure.position.x);
            const py = projectY(structure.position.y);
            const color = config.structureColors[structure.typeKey] || "#9fb6cc";
            const size = structure.typeKey === "turret" ? 5 : 4;
            ctx.fillStyle = color;
            ctx.fillRect(px - size / 2, py - size / 2, size, size);
        }

        for (const enemy of enemyWaves.enemies) {
            if (!enemy.alive) continue;
            const px = projectX(enemy.position.x);
            const py = projectY(enemy.position.y);
            ctx.fillStyle = config.enemyColor;
            ctx.fillRect(px - 2, py - 2, 3, 3);
        }

        const houseX = projectX(world.house.position.x);
        const houseY = projectY(world.house.position.y);
        ctx.fillStyle = config.houseColor;
        ctx.beginPath();
        ctx.arc(houseX, houseY, 4.5, 0, Math.PI * 2);
        ctx.fill();

        const playerX = projectX(player.position.x);
        const playerY = projectY(player.position.y);
        ctx.fillStyle = config.playerColor;
        ctx.beginPath();
        ctx.arc(playerX, playerY, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(17, 25, 35, 0.85)";
        ctx.lineWidth = 1;
        ctx.stroke();

        const viewWidth = CANVAS_WIDTH * scaleX;
        const viewHeight = CANVAS_HEIGHT * scaleY;
        const camX = Math.min(x + width - viewWidth - 3, Math.max(x + 3, x + gameState.camera.x * scaleX));
        const camY = Math.min(y + height - viewHeight - 3, Math.max(y + 3, y + gameState.camera.y * scaleY));
        ctx.strokeStyle = config.cameraStroke;
        ctx.lineWidth = 1;
        ctx.strokeRect(camX, camY, viewWidth, viewHeight);

        ctx.fillStyle = "#d4dde8";
        ctx.font = "10px Segoe UI";
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.fillText(`Day ${gameState.dayNumber}`, x + 8, y + 6);
        const status = gameState.phase === "night"
            ? `Night: ${Math.max(0, enemyWaves.enemies.length + enemyWaves.toSpawn)}`
            : `Day: ${Math.max(0, Math.ceil(gameState.phaseTimer))}s`;
        ctx.fillText(status, x + 8, y + 18);
        ctx.textBaseline = "bottom";
        ctx.fillText(`House HP ${Math.max(0, Math.round(world.house.hp))}`, x + 8, y + height - 6);

        ctx.restore();
    }


    function drawExteriorDoorPrompt() {
        if (!world.isNearHouseDoor(player.position, world.house.door.radius * 0.85)) {
            return;
        }
        const door = world.getHouseDoorOutsidePosition();
        const screenX = door.x - gameState.camera.x;
        const screenY = door.y - gameState.camera.y;
        ctx.save();
        ctx.fillStyle = "rgba(12, 18, 26, 0.6)";
        ctx.fillRect(screenX - 88, screenY - 74, 176, 32);
        ctx.fillStyle = "#f0f6ff";
        ctx.font = "17px Segoe UI";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("Press E to enter", screenX, screenY - 58);
        ctx.restore();
    }

    function renderHouseInterior() {
        ctx.save();
        ctx.fillStyle = "#101720";
        ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

        const { offsetX, offsetY } = getInteriorOffsets();
        const hasComputerSelection = input.buildSelection === "computer";
        const hasComputerKit = hasComputerSelection && typeof inventory?.hasStructureKit === "function"
            ? inventory.hasStructureKit("computer")
            : false;

        ctx.fillStyle = houseInterior.wallColor;
        ctx.fillRect(offsetX, offsetY, houseInterior.width, houseInterior.height);

        const floorX = offsetX + houseInterior.wallThickness;
        const floorY = offsetY + houseInterior.wallThickness;
        const floorWidth = houseInterior.width - houseInterior.wallThickness * 2;
        const floorHeight = houseInterior.height - houseInterior.wallThickness * 2;
        ctx.fillStyle = houseInterior.floorColor;
        ctx.fillRect(floorX, floorY, floorWidth, floorHeight);

        if (houseInterior.rug) {
            ctx.fillStyle = houseInterior.rugColor;
            const rug = houseInterior.rug;
            ctx.fillRect(offsetX + rug.x, offsetY + rug.y, rug.width, rug.height);
        }

        for (const piece of houseInterior.furniture) {
            ctx.fillStyle = piece.color;
            ctx.fillRect(offsetX + piece.x, offsetY + piece.y, piece.width, piece.height);
        }

        const activeComputer = findInteriorComputerNear(interiorState.position, 28);
        for (const computer of houseInterior.computers) {
            const drawX = offsetX + computer.position.x;
            const drawY = offsetY + computer.position.y;
            const isActive = Boolean(activeComputer && activeComputer.id === computer.id);
            const width = computer.width;
            const height = computer.height;
            ctx.save();
            ctx.translate(drawX, drawY);
            ctx.fillStyle = "#1d2735";
            ctx.fillRect(-width / 2, -height / 2, width, height);
            ctx.fillStyle = isActive && !gameState.computerOverlayOpen ? "#3aa0ff" : "#0a84ff";
            ctx.fillRect(-width / 2 + 22, -height / 2 + 18, width - 44, height / 2.15);
            ctx.fillStyle = "#0b111a";
            ctx.fillRect(-width / 2 + 18, height / 2 - 36, width - 36, 18);
            ctx.fillStyle = "#151f2d";
            ctx.fillRect(-width / 2 + 12, height / 2 - 14, width - 24, 12);
            ctx.restore();
            if (isActive && !gameState.computerOverlayOpen) {
                ctx.save();
                ctx.strokeStyle = "rgba(47, 155, 255, 0.5)";
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.ellipse(drawX, drawY + computer.height / 3.2, computer.width / 1.9, computer.height / 2.4, 0, 0, Math.PI * 2);
                ctx.stroke();
                ctx.restore();
            }
        }

        if (hasComputerSelection) {
            const placement = houseInterior.computerPlacement;
            const pointer = canvasToInteriorPosition(input.mouse.worldX, input.mouse.worldY);
            let displayPosition = null;
            let usingFallback = false;
            if (pointer) {
                const pointerRect = makeRect(pointer, placement.width, placement.height, 0);
                const pointerInside = isRectInsideInteriorBounds(pointerRect);
                const candidate = pointerInside
                    ? pointer
                    : clampInteriorPosition(pointer, placement.width, placement.height);
                if (isRectInsideInteriorBounds(makeRect(candidate, placement.width, placement.height, 0))) {
                    displayPosition = candidate;
                }
            }
            if (!displayPosition) {
                const fallback = findNearestValidComputerPosition(pointer ?? interiorState.position);
                if (fallback) {
                    displayPosition = fallback;
                    usingFallback = true;
                }
            }
            if (displayPosition) {
                const placementValid = isInteriorComputerPlacementValid(displayPosition);
                const kitReady = hasComputerKit && placementValid;
                const screenX = offsetX + displayPosition.x;
                const screenY = offsetY + displayPosition.y;
                let fillColor = kitReady ? "#8be78b" : "#ff6b6b";
                if (usingFallback && kitReady) {
                    fillColor = "#f5d67d";
                }
                const detailColor = kitReady ? "rgba(10, 132, 255, 0.45)" : "rgba(255, 107, 107, 0.4)";
                ctx.save();
                ctx.globalAlpha = 0.46;
                ctx.translate(screenX, screenY);
                ctx.fillStyle = fillColor;
                ctx.fillRect(-placement.width / 2, -placement.height / 2, placement.width, placement.height);
                ctx.fillStyle = detailColor;
                ctx.fillRect(-placement.width / 2 + 22, -placement.height / 2 + 18, placement.width - 44, placement.height / 2.15);
                ctx.restore();
            }
        }

        const table = houseInterior.craftingTable;
        const tableX = offsetX + table.position.x - table.width / 2;
        const tableY = offsetY + table.position.y - table.height / 2;
        const tableAsset = getAsset("craftingTable");
        ctx.save();
        if (tableAsset?.loaded) {
            ctx.drawImage(tableAsset.image, tableX, tableY, table.width, table.height);
        } else {
            ctx.fillStyle = "#3b2f1f";
            ctx.fillRect(tableX, tableY, table.width, table.height);
            ctx.fillStyle = "#1f1410";
            ctx.fillRect(tableX + 6, tableY + 12, table.width - 12, table.height - 24);
        }
        if (gameState.craftingOpen) {
            ctx.strokeStyle = "rgba(123, 224, 166, 0.6)";
            ctx.lineWidth = 3;
            ctx.strokeRect(tableX - 6, tableY - 6, table.width + 12, table.height + 12);
        } else if (isInsideCraftingZone(interiorState.position, table.radius)) {
            ctx.fillStyle = "rgba(12, 18, 26, 0.6)";
            ctx.fillRect(tableX - 24, tableY - 48, table.width + 48, 32);
            ctx.fillStyle = "#e9efff";
            ctx.font = "17px Segoe UI";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText("Press E to craft", tableX + table.width / 2, tableY - 32);
        }
        ctx.restore();

        if (!gameState.craftingOpen && !gameState.computerOverlayOpen && activeComputer) {
            const compX = offsetX + activeComputer.position.x;
            const compY = offsetY + activeComputer.position.y;
            ctx.fillStyle = "rgba(12, 18, 26, 0.6)";
            ctx.fillRect(compX - 112, compY - activeComputer.height / 2 - 60, 224, 32);
            ctx.fillStyle = "#e9efff";
            ctx.font = "17px Segoe UI";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText("Press E to use computer", compX, compY - activeComputer.height / 2 - 44);
        }

        const door = houseInterior.door;
        const doorX = offsetX + door.position.x - door.width / 2;
        const doorY = offsetY + door.position.y - door.height;
        ctx.fillStyle = "#2b1b0f";
        ctx.fillRect(doorX, doorY, door.width, door.height);
        ctx.fillStyle = "rgba(255, 255, 255, 0.1)";
        ctx.fillRect(doorX, doorY, door.width, 6);
        ctx.fillStyle = "rgba(16, 12, 8, 0.35)";
        ctx.fillRect(doorX, doorY + door.height, door.width, 10);

        const drawX = offsetX + interiorState.position.x;
        const drawY = offsetY + interiorState.position.y;
        const sprite = getAsset("player");
        let playerWidth;
        let playerHeight;
        if (sprite?.loaded) {
            const drawSize = 56;
            const aspect = sprite.image.width / sprite.image.height;
            playerWidth = drawSize;
            playerHeight = drawSize / aspect;
            ctx.drawImage(sprite.image, drawX - playerWidth / 2, drawY - playerHeight / 2, playerWidth, playerHeight);
        } else {
            playerWidth = player.size;
            playerHeight = player.size;
            ctx.fillStyle = "#5bc0de";
            ctx.beginPath();
            ctx.arc(drawX, drawY, player.size / 2, 0, Math.PI * 2);
            ctx.fill();
        }
        player.drawHeldItem(
            ctx,
            drawX,
            drawY,
            playerWidth,
            playerHeight,
            { x: Number.isFinite(input.mouse.worldX) ? input.mouse.worldX : player.position.x, y: Number.isFinite(input.mouse.worldY) ? input.mouse.worldY : player.position.y }
        );

        if (!gameState.craftingOpen && isInsideDoorZone(interiorState.position, houseInterior.door.radius * 0.9)) {
            ctx.fillStyle = "rgba(12, 18, 26, 0.6)";
            ctx.fillRect(drawX - 96, drawY - 82, 192, 34);
            ctx.fillStyle = "#e9efff";
            ctx.font = "17px Segoe UI";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText("Press E to step outside", drawX, drawY - 65);
        }

        ctx.restore();
    }

    function renderGame() {
        if (gameState.inHouse) {
            renderHouseInterior();
        } else {
            world.drawGround(ctx, gameState.phase, gameState.camera);
            resources.drawNodes(ctx, gameState.camera);
            loot.draw(ctx, gameState.camera, player);
            world.drawHouse(ctx, gameState.camera);
            structures.draw(ctx, gameState.camera);
            for (const enemy of enemyWaves.enemies) {
                // If enemy instance has a draw method (host/local), call it. If not (plain snapshot), draw a simple representation.
                if (enemy && typeof enemy.draw === "function") {
                    try {
                        enemy.draw(ctx, gameState.camera);
                    } catch (err) {
                        // Fall back to simple draw below on error
                        const e = enemy || {};
                        const drawX = (e.position?.x ?? 0) - gameState.camera.x;
                        const drawY = (e.position?.y ?? 0) - gameState.camera.y;
                        const radius = e.radius ?? 18;
                        ctx.fillStyle = e.hitFlash > 0 ? "#f26d85" : "#b84a62";
                        ctx.beginPath();
                        ctx.arc(drawX, drawY, radius, 0, Math.PI * 2);
                        ctx.fill();
                    }
                } else {
                    const e = enemy || {};
                    const drawX = (e.position?.x ?? 0) - gameState.camera.x;
                    const drawY = (e.position?.y ?? 0) - gameState.camera.y;
                    const radius = e.radius ?? 18;
                    ctx.fillStyle = e.hitFlash > 0 ? "#f26d85" : "#b84a62";
                    ctx.beginPath();
                    ctx.arc(drawX, drawY, radius, 0, Math.PI * 2);
                    ctx.fill();
                    // Health bar
                    ctx.fillStyle = "#000";
                    ctx.fillRect(drawX - 18, drawY - radius - 10, 36, 4);
                    ctx.fillStyle = "#d5dbe0";
                    const hpPercent = (e.health && e.maxHealth) ? Math.max(0, Math.min(1, e.health / e.maxHealth)) : 1;
                    ctx.fillRect(drawX - 18, drawY - radius - 10, 36 * hpPercent, 4);
                }
            }
            const pointer = { x: Number.isFinite(input.mouse.worldX) ? input.mouse.worldX : player.position.x, y: Number.isFinite(input.mouse.worldY) ? input.mouse.worldY : player.position.y };
            player.draw(ctx, gameState.camera, pointer);
            for (const [id, p] of Object.entries(remotePlayers)) {
                if (!p || (window.__MP__?.id && id === window.__MP__.id)) {
                    continue;
                }
                const drawX = (Number.isFinite(p.x) ? p.x : player.position.x) - gameState.camera.x;
                const drawY = (Number.isFinite(p.y) ? p.y : player.position.y) - gameState.camera.y;
                const direction = Number.isFinite(p.dir) ? p.dir : 0;

                ctx.save();
                ctx.translate(drawX, drawY);
                ctx.globalAlpha = 0.82;
                ctx.fillStyle = "#7be0a6";
                ctx.beginPath();
                ctx.arc(0, 0, 10, 0, Math.PI * 2);
                ctx.fill();
                ctx.strokeStyle = "rgba(123, 224, 166, 0.85)";
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(0, 0);
                ctx.lineTo(Math.cos(direction) * 18, Math.sin(direction) * 18);
                ctx.stroke();
                ctx.restore();

                const labelLines = [];
                if (p.name) {
                    labelLines.push(String(p.name));
                }
                if (p.heldItem?.name) {
                    labelLines.push(p.heldItem.name);
                } else if (p.equipment?.weapon?.name) {
                    labelLines.push(p.equipment.weapon.name);
                }
                if (p.currentBuildSelection) {
                    labelLines.push(`Kit: ${formatName(p.currentBuildSelection)}`);
                }

                if (labelLines.length) {
                    ctx.save();
                    ctx.font = "13px Segoe UI";
                    ctx.textAlign = "center";
                    ctx.textBaseline = "bottom";
                    const totalHeight = labelLines.length * 15 + 6;
                    const boxTop = drawY - 20 - totalHeight;
                    ctx.fillStyle = "rgba(12, 18, 26, 0.55)";
                    ctx.fillRect(drawX - 70, boxTop, 140, totalHeight + 4);
                    ctx.strokeStyle = "rgba(123, 224, 166, 0.35)";
                    ctx.lineWidth = 1;
                    ctx.strokeRect(drawX - 70, boxTop, 140, totalHeight + 4);

                    let lineOffset = boxTop + totalHeight + 1;
                    labelLines.forEach((line, index) => {
                        ctx.fillStyle = index === 0 ? "#e9efff" : "#cbe8dd";
                        ctx.fillText(line, drawX, lineOffset);
                        lineOffset -= 15;
                    });
                    ctx.restore();
                }
            }
            effects.draw(ctx, gameState.camera);

            if (gameState.phase === "night") {
                ctx.fillStyle = "rgba(10, 10, 25, 0.22)";
                ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
            }

            drawExteriorDoorPrompt();
            drawBuildGhost();
            drawMinimap();
        }

        if (gameState.gameOver) {
            ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
            ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
            ctx.fillStyle = "#ff4d6d";
            ctx.font = "36px Segoe UI";
            ctx.textAlign = "center";
            ctx.fillText("Game Over", CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2);
            ctx.font = "20px Segoe UI";
            ctx.fillStyle = "#f5f5f5";
            ctx.fillText("Use the restart button to try again.", CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2 + 32);
        }
    }

    function gameLoop(timestamp) {
        const deltaSeconds = Math.min(0.1, (timestamp - lastTimestamp) / 1000);
        lastTimestamp = timestamp;

        updateGame(deltaSeconds);
        renderGame();

        requestAnimationFrame(gameLoop);
    }

    requestAnimationFrame(gameLoop);
}

init().catch((error) => {
    console.error("Failed to initialize game", error);
});








