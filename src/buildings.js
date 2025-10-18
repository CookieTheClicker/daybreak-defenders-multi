import { STRUCTURE_TYPES, MAP_WIDTH, MAP_HEIGHT } from "./constants.js";
import { getAsset } from "./assets.js";
import { distance } from "./utils.js";

const PLACEMENT_BUFFER = 40;
const UPGRADE_COST_MULTIPLIER = 0.6;
const TURRET_ROTATION_OFFSET = Math.PI / 2;
let structureIdCounter = 1;

function generateStructureId() {
    const timestamp = Date.now().toString(36);
    const counter = (structureIdCounter++).toString(36);
    return `structure-${timestamp}-${counter}`;
}

function cloneCost(cost, multiplier = 1) {
    const result = {};
    for (const [key, value] of Object.entries(cost)) {
        result[key] = Math.ceil(value * multiplier);
    }
    return result;
}

function createStructureState(typeKey, position, rotation, id) {
    const blueprint = STRUCTURE_TYPES[typeKey];
    const assignedId = id || generateStructureId();
    const base = {
        id: assignedId,
        typeKey,
        blueprint,
        position: { ...position },
        size: blueprint.size,
        rotation,
        level: 1,
        hp: blueprint.maxHp,
        maxHp: blueprint.maxHp,
        fireCooldown: 0
    };

    if (typeKey === "turret") {
        base.stats = {
            range: blueprint.range,
            damage: blueprint.damage,
            fireRate: blueprint.fireRate
        };
    }
    if (typeKey === "spike") {
        base.stats = {
            dps: blueprint.damagePerSecond
        };
    }
    return base;
}

export class StructureManager {
    constructor(world) {
        this.world = world;
        this.structures = [];
        this.onStructurePlaced = null;
        this.onStructureRemoved = null;
        this.onStructureUpdated = null;
    }

    isPlacementValid(typeKey, position) {
        const blueprint = STRUCTURE_TYPES[typeKey];
        if (!blueprint) return false;
        const half = blueprint.size / 2;
        const width = this.world?.getWidth?.() ?? this.world?.baseWidth ?? MAP_WIDTH;
        const height = this.world?.getHeight?.() ?? this.world?.baseHeight ?? MAP_HEIGHT;
        if (
            position.x - half < 0 ||
            position.x + half > width ||
            position.y - half < 0 ||
            position.y + half > height
        ) {
            return false;
        }
        for (const structure of this.structures) {
            if (distance(structure.position, position) < (structure.size + blueprint.size) / 2 + PLACEMENT_BUFFER) {
                return false;
            }
        }
        return true;
    }

    attemptPlacement(typeKey, position, inventory, rotation = 0) {
        const blueprint = STRUCTURE_TYPES[typeKey];
        if (!blueprint) return { success: false, reason: "Unknown structure" };
        if (blueprint.indoorOnly) {
            return { success: false, reason: "Must be installed indoors" };
        }

        if (!this.isPlacementValid(typeKey, position)) {
            return { success: false, reason: "Invalid placement" };
        }

        if (!inventory?.consumeStructureKit || !inventory.consumeStructureKit(typeKey)) {
            return { success: false, reason: "Requires crafted kit" };
        }

        const structure = createStructureState(typeKey, position, rotation);
        this.structures.push(structure);
        if (typeof this.onStructurePlaced === "function") {
            this.onStructurePlaced(structure);
        }
        return { success: true, structure };
    }

    attemptUpgrade(structure, inventory) {
        if (!structure) return { success: false, reason: "No structure selected" };
        const cost = cloneCost(structure.blueprint.cost, UPGRADE_COST_MULTIPLIER * structure.level);
        if (!inventory.spendResources(cost)) {
            return { success: false, reason: "Not enough resources" };
        }
        structure.level += 1;
        structure.maxHp = Math.round(structure.maxHp * 1.25);
        structure.hp = structure.maxHp;
        if (structure.typeKey === "turret") {
            structure.stats.damage = Math.round(structure.stats.damage * 1.2);
            structure.stats.range = Math.round(structure.stats.range * 1.05);
            structure.stats.fireRate = parseFloat((structure.stats.fireRate * 1.1).toFixed(2));
        }
        if (structure.typeKey === "spike") {
            structure.stats.dps = Math.round(structure.stats.dps * 1.2);
        }
        if (typeof this.onStructureUpdated === "function") {
            this.onStructureUpdated(structure, { reason: "upgrade" });
        }
        return { success: true };
    }

    findStructureNear(point) {
        for (const structure of this.structures) {
            if (distance(structure.position, point) <= structure.size) {
                return structure;
            }
        }
        return null;
    }

    damageStructure(target, amount) {
        target.hp = Math.max(0, target.hp - amount);
        const destroyed = target.hp <= 0;
        if (destroyed) {
            this.structures = this.structures.filter((s) => s !== target);
            if (typeof this.onStructureRemoved === "function") {
                this.onStructureRemoved(target);
            }
            return true;
        }
        if (typeof this.onStructureUpdated === "function") {
            this.onStructureUpdated(target, { reason: "damage" });
        }
        return false;
    }

    update(deltaSeconds, enemies, effectManager) {
        const applyDamageToEnemy = (enemy, amount) => {
            if (!enemy) return false;
            // If enemy is a proper class instance with takeDamage(), use it.
            if (typeof enemy.takeDamage === "function") {
                try {
                    return enemy.takeDamage(amount);
                } catch (err) {
                    // fall through to manual apply
                }
            }
            // Manual fallback for snapshot/plain enemy objects
            if (!Number.isFinite(enemy.health)) {
                enemy.health = Number.isFinite(enemy.maxHealth) ? enemy.maxHealth : 0;
            }
            enemy.health = Math.max(0, enemy.health - amount);
            if (enemy.health <= 0) {
                enemy.alive = false;
                return true;
            }
            return false;
        };

        for (const structure of this.structures) {
            if (structure.typeKey === "spike") {
                for (const enemy of enemies) {
                    if (!enemy.alive) continue;
                    const dist = distance(structure.position, enemy.position);
                    if (dist <= (structure.size / 2) + enemy.radius) {
                        applyDamageToEnemy(enemy, structure.stats.dps * deltaSeconds);
                    }
                }
            }
            if (structure.typeKey === "turret") {
                structure.fireCooldown = Math.max(0, structure.fireCooldown - deltaSeconds);
                if (structure.fireCooldown <= 0) {
                    let target = null;
                    let closest = Infinity;
                    for (const enemy of enemies) {
                        if (!enemy.alive) continue;
                        const dist = distance(structure.position, enemy.position);
                        if (dist < structure.stats.range && dist < closest) {
                            closest = dist;
                            target = enemy;
                        }
                    }
                    if (target) {
                        const targetPosition = { ...target.position };
                        const aimAngle = Math.atan2(targetPosition.y - structure.position.y, targetPosition.x - structure.position.x);
                        const killed = applyDamageToEnemy(target, structure.stats.damage);
                        structure.fireCooldown = 1 / structure.stats.fireRate;
                        structure.rotation = aimAngle;
                        if (effectManager) {
                            const muzzleOffset = structure.size * 0.48;
                            const projectileStart = {
                                x: structure.position.x + Math.cos(aimAngle) * muzzleOffset,
                                y: structure.position.y + Math.sin(aimAngle) * muzzleOffset
                            };
                            effectManager.spawnProjectile({
                                from: projectileStart,
                                to: targetPosition,
                                color: "#ffe7a1",
                                speed: 860,
                                radius: 4
                            });
                            effectManager.spawnPulse({
                                position: { ...structure.position },
                                startRadius: 6,
                                endRadius: 46,
                                color: "rgba(132, 182, 255, 0.6)"
                            });
                            effectManager.spawnFloatingText({
                                text: `-${structure.stats.damage}`,
                                position: targetPosition,
                                color: "#ffd166"
                            });
                            if (killed) {
                                effectManager.spawnFloatingText({
                                    text: "Down!",
                                    position: { x: targetPosition.x, y: targetPosition.y - 24 },
                                    color: "#ff8ba7"
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    draw(ctx, camera) {
        for (const structure of this.structures) {
            const asset = getAsset(structure.typeKey);
            ctx.save();
            ctx.translate(structure.position.x - camera.x, structure.position.y - camera.y);
            if (structure.typeKey === "turret") {
                ctx.rotate((structure.rotation ?? 0) + TURRET_ROTATION_OFFSET);
            }
            if (asset?.loaded) {
                const size = structure.size;
                ctx.drawImage(asset.image, -size / 2, -size / 2, size, size);
            } else {
                ctx.fillStyle = structure.blueprint.color;
                ctx.fillRect(-structure.size / 2, -structure.size / 2, structure.size, structure.size);
            }
            ctx.restore();

            ctx.fillStyle = "#000";
            ctx.fillRect(structure.position.x - camera.x - 24, structure.position.y - camera.y - structure.size / 2 - 12, 48, 5);
            ctx.fillStyle = "#4caf50";
            const hpRatio = structure.hp / structure.maxHp;
            ctx.fillRect(structure.position.x - camera.x - 24, structure.position.y - camera.y - structure.size / 2 - 12, 48 * hpRatio, 5);
        }
    }

    removeStructureById(id, options = {}) {
        if (!id) {
            return false;
        }
        const index = this.structures.findIndex((structure) => structure.id === id);
        if (index === -1) {
            return false;
        }
        const [removed] = this.structures.splice(index, 1);
        if (!options.silent && typeof this.onStructureRemoved === "function") {
            this.onStructureRemoved(removed);
        }
        return true;
    }

    upsertStructureSnapshot(snapshot = {}, options = {}) {
        if (!snapshot || typeof snapshot !== "object") {
            return null;
        }
        const { id, typeKey, position, rotation = 0, level = 1, hp = null, maxHp = null, stats = null } = snapshot;
        if (!typeKey || !position) {
            return null;
        }
        const existingIndex = id ? this.structures.findIndex((structure) => structure.id === id) : -1;
        if (existingIndex !== -1) {
            const target = this.structures[existingIndex];
            target.position = { ...position };
            target.rotation = rotation;
            target.level = level;
            target.maxHp = Number.isFinite(maxHp) ? maxHp : target.maxHp;
            target.hp = Number.isFinite(hp) ? hp : Math.min(target.hp, target.maxHp);
            if (stats && target.stats) {
                target.stats = { ...target.stats, ...stats };
            }
            if (!options.silent && typeof this.onStructureUpdated === "function") {
                this.onStructureUpdated(target, { reason: "snapshot" });
            }
            return target;
        }
        const structure = createStructureState(typeKey, position, rotation, id);
        structure.level = level;
        structure.maxHp = Number.isFinite(maxHp) ? maxHp : structure.maxHp;
        structure.hp = Number.isFinite(hp) ? hp : structure.maxHp;
        if (structure.stats && stats) {
            structure.stats = { ...structure.stats, ...stats };
        }
        this.structures.push(structure);
        if (!options.silent && typeof this.onStructurePlaced === "function") {
            this.onStructurePlaced(structure);
        }
        return structure;
    }

    replaceAll(structureSnapshots = []) {
        if (!Array.isArray(structureSnapshots)) {
            return;
        }
        this.structures.length = 0;
        for (const snapshot of structureSnapshots) {
            this.upsertStructureSnapshot(snapshot, { silent: true });
        }
    }
}
