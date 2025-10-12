import { ENEMY_STATS, WORLD_SETTINGS } from "./constants.js";
import { distance } from "./utils.js";
import { getAsset } from "./assets.js";

function randomSpawnPosition() {
    const edge = Math.floor(Math.random() * 4);
    const { x, y } = WORLD_SETTINGS.housePosition;
    const radius = WORLD_SETTINGS.resourceRadius + 260;
    switch (edge) {
        case 0:
            return { x: x - radius, y: y - radius + Math.random() * radius * 2 };
        case 1:
            return { x: x + radius, y: y - radius + Math.random() * radius * 2 };
        case 2:
            return { x: x - radius + Math.random() * radius * 2, y: y - radius };
        default:
            return { x: x - radius + Math.random() * radius * 2, y: y + radius };
    }
}

const PLAYER_AGGRO_RADIUS = 280;

export class Enemy {
    constructor(waveNumber, modifiers = {}) {
        this.position = randomSpawnPosition();
        this.radius = 18;
        const healthMultiplier = modifiers.healthMultiplier ?? 1;
        const speedMultiplier = modifiers.speedMultiplier ?? 1;
        const damageMultiplier = modifiers.damageMultiplier ?? 1;
        this.health = (ENEMY_STATS.baseHealth + waveNumber * 14) * healthMultiplier;
        this.maxHealth = this.health;
        this.speed = (ENEMY_STATS.baseSpeed + waveNumber * 6) * speedMultiplier;
        this.damage = (ENEMY_STATS.baseDamage + waveNumber * 2) * damageMultiplier;
        this.alive = true;
        this.attackCooldown = 0;
        this.waveNumber = waveNumber;
        this.hitFlash = 0;
    }

    takeDamage(amount) {
        this.health -= amount;
        this.hitFlash = 0.18;
        if (this.health <= 0) {
            this.alive = false;
            return true;
        }
        return false;
    }

    update(deltaSeconds, world, structureManager, player, isNight) {
        if (!this.alive) return null;

        this.hitFlash = Math.max(0, this.hitFlash - deltaSeconds);
        this.attackCooldown = Math.max(0, this.attackCooldown - deltaSeconds);

        let targetStructure = null;
        let closestStructure = Infinity;
        for (const structure of structureManager.structures) {
            const dist = distance(this.position, structure.position);
            if (dist < closestStructure) {
                closestStructure = dist;
                targetStructure = structure;
            }
        }

        const houseDist = distance(this.position, world.house.position);
        const playerActive = isNight && player?.isAlive?.();
        const playerDist = playerActive ? distance(this.position, player.position) : Infinity;
        const playerRange = playerActive ? this.radius + (player.size ?? 0) / 2 + 4 : Infinity;
        const chasePlayer = playerActive && playerDist <= PLAYER_AGGRO_RADIUS;

        if (chasePlayer && playerDist <= playerRange) {
            if (this.attackCooldown <= 0) {
                const result = player.takeDamage(this.damage);
                this.attackCooldown = ENEMY_STATS.damageInterval;
                return { playerHit: { damage: result.applied, killed: result.killed } };
            }
            return null;
        }

        if (targetStructure && closestStructure <= (targetStructure.size / 2) + this.radius && (!chasePlayer || closestStructure < playerDist)) {
            if (this.attackCooldown <= 0) {
                structureManager.damageStructure(targetStructure, this.damage);
                this.attackCooldown = ENEMY_STATS.damageInterval;
            }
            return null;
        }

        if (houseDist <= world.house.size / 2 + this.radius && (!chasePlayer || houseDist < playerDist)) {
            if (this.attackCooldown <= 0) {
                const destroyed = world.damageHouse(this.damage);
                this.attackCooldown = ENEMY_STATS.damageInterval;
                if (destroyed) {
                    this.alive = false;
                }
            }
            return null;
        }

        const targetPoint = chasePlayer
            ? player.position
            : targetStructure && closestStructure < houseDist
                ? targetStructure.position
                : world.house.position;

        const dirX = targetPoint.x - this.position.x;
        const dirY = targetPoint.y - this.position.y;
        const length = Math.hypot(dirX, dirY) || 1;
        const normX = dirX / length;
        const normY = dirY / length;
        this.position.x += normX * this.speed * deltaSeconds;
        this.position.y += normY * this.speed * deltaSeconds;
        return null;
    }

    draw(ctx, camera) {
        if (!this.alive) return;
        const drawX = this.position.x - camera.x;
        const drawY = this.position.y - camera.y;
        const asset = getAsset("enemy");
        if (asset?.loaded) {
            const drawSize = 44;
            const aspect = asset.image.width / asset.image.height;
            const width = drawSize;
            const height = width / aspect;
            ctx.save();
            if (this.hitFlash > 0) {
                ctx.globalAlpha = 0.9;
            }
            ctx.drawImage(asset.image, drawX - width / 2, drawY - height / 2, width, height);
            ctx.restore();
        } else {
            ctx.fillStyle = this.hitFlash > 0 ? "#f26d85" : "#b84a62";
            ctx.beginPath();
            ctx.arc(drawX, drawY, this.radius, 0, Math.PI * 2);
            ctx.fill();
        }

        ctx.fillStyle = "#000";
        ctx.fillRect(drawX - 18, drawY - this.radius - 10, 36, 4);
        ctx.fillStyle = "#d5dbe0";
        ctx.fillRect(drawX - 18, drawY - this.radius - 10, 36 * (this.health / this.maxHealth), 4);
    }
}

export class EnemyWaveManager {
    constructor(modifiers = {}) {
        this.waveNumber = 0;
        this.enemies = [];
        this.toSpawn = 0;
        this.spawnCooldown = 0;
        this.active = false;
        this.modifiers = {
            damageMultiplier: modifiers.enemyDamageMultiplier ?? 1,
            healthMultiplier: modifiers.enemyHealthMultiplier ?? 1,
            speedMultiplier: modifiers.enemySpeedMultiplier ?? 1,
            spawnMultiplier: modifiers.spawnMultiplier ?? 1
        };
    }

    configureDifficulty(modifiers = {}) {
        this.modifiers = {
            damageMultiplier: modifiers.enemyDamageMultiplier ?? this.modifiers.damageMultiplier ?? 1,
            healthMultiplier: modifiers.enemyHealthMultiplier ?? this.modifiers.healthMultiplier ?? 1,
            speedMultiplier: modifiers.enemySpeedMultiplier ?? this.modifiers.speedMultiplier ?? 1,
            spawnMultiplier: modifiers.spawnMultiplier ?? this.modifiers.spawnMultiplier ?? 1
        };
    }

    startWave(dayNumber) {
        this.waveNumber = dayNumber;
        this.enemies = [];
        const baseCount = 6 + dayNumber * 4;
        const scaledCount = Math.ceil(baseCount * (this.modifiers.spawnMultiplier ?? 1));
        this.toSpawn = scaledCount;
        this.spawnCooldown = 0;
        this.active = true;
    }

    update(deltaSeconds, world, structureManager, inventory, effectManager, player, isNight) {
        if (!this.active) return { playerHits: [] };

        const events = { playerHits: [] };
        this.spawnCooldown -= deltaSeconds;
        if (this.toSpawn > 0 && this.spawnCooldown <= 0) {
            const enemy = new Enemy(this.waveNumber, this.modifiers);
            this.enemies.push(enemy);
            this.toSpawn -= 1;
            this.spawnCooldown = Math.max(0.3, 1.4 - this.waveNumber * 0.12);
            if (effectManager) {
                effectManager.spawnPulse({
                    position: { ...enemy.position },
                    startRadius: 12,
                    endRadius: 48,
                    color: "rgba(255, 102, 133, 0.35)"
                });
            }
        }

        for (const enemy of this.enemies) {
            const wasAlive = enemy.alive;
            const result = enemy.update(deltaSeconds, world, structureManager, player, isNight);
            if (result?.playerHit) {
                events.playerHits.push({ enemy, ...result.playerHit });
            }
            if (wasAlive && !enemy.alive) {
                if (inventory && Math.random() < 0.35) {
                    const loot = Math.random() < 0.5
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
                    if (inventory.addItem(loot) && effectManager) {
                        effectManager.spawnFloatingText({
                            text: `Loot: ${loot.name}`,
                            position: { ...enemy.position },
                            color: "#7be0a6"
                        });
                    }
                }
                if (effectManager) {
                    effectManager.spawnFloatingText({
                        text: "+1 wave XP",
                        position: { ...enemy.position },
                        color: "#ff8ba7"
                    });
                }
            }
        }

        this.enemies = this.enemies.filter((enemy) => enemy.alive);

        if (this.toSpawn <= 0 && this.enemies.length === 0) {
            this.active = false;
        }

        return events;
    }
}
