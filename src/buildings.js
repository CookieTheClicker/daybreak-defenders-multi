import { STRUCTURE_TYPES, MAP_WIDTH, MAP_HEIGHT } from "./constants.js";
import { getAsset } from "./assets.js";
import { distance } from "./utils.js";

const PLACEMENT_BUFFER = 40;
const UPGRADE_COST_MULTIPLIER = 0.6;
const TURRET_ROTATION_OFFSET = Math.PI / 2;
let structureIdCounter = 1;

function cloneCost(cost, multiplier = 1) {
    const result = {};
    for (const [key, value] of Object.entries(cost)) {
        result[key] = Math.ceil(value * multiplier);
    }
    return result;
}

function createStructureState(typeKey, position, rotation) {
    const blueprint = STRUCTURE_TYPES[typeKey];
    const base = {
        id: structureIdCounter++,
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

        if (!this.isPlacementValid(typeKey, position)) {
            return { success: false, reason: "Invalid placement" };
        }

        if (!inventory?.consumeStructureKit || !inventory.consumeStructureKit(typeKey)) {
            return { success: false, reason: "Requires crafted kit" };
        }

        const structure = createStructureState(typeKey, position, rotation);
        this.structures.push(structure);
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
        if (target.hp <= 0) {
            this.structures = this.structures.filter((s) => s !== target);
            return true;
        }
        return false;
    }

    update(deltaSeconds, enemies, effectManager) {
        for (const structure of this.structures) {
            if (structure.typeKey === "spike") {
                for (const enemy of enemies) {
                    if (!enemy.alive) continue;
                    const dist = distance(structure.position, enemy.position);
                    if (dist <= (structure.size / 2) + enemy.radius) {
                        enemy.takeDamage(structure.stats.dps * deltaSeconds);
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
                        const killed = target.takeDamage(structure.stats.damage);
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
}