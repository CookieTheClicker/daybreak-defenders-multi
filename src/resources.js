import { WORLD_SETTINGS, RESOURCE_TYPES } from "./constants.js";
import { randomInCircle, distance, clamp } from "./utils.js";
import { getAsset } from "./assets.js";
import { createBerryItem, BERRY_STACK_KEY } from "./inventory.js";

const GATHER_AMOUNT = {
    wood: 4,
    stone: 3,
    metal: 2,
    berries: 5
};

const NODE_CAPACITY = {
    wood: 60,
    stone: 48,
    metal: 36,
    berries: 40
};

const NODE_DRAW_SIZE = {
    wood: 84,
    stone: 72,
    metal: 64,
    berries: 72
};

const HARVEST_REWARD = {
    wood: 50,
    stone: 45,
    metal: 36,
    berries: 40
};

const GATHER_RANGE = 56;

export class ResourceManager {
    constructor(inventory, world, worldSettings = WORLD_SETTINGS, modifiers = {}) {
        this.inventory = inventory;
        this.world = world;
        this.worldSettings = worldSettings;
        this.nodes = [];
        this.initialized = false;
        this.lastRegrowDay = 1;
        this.resourceYieldMultiplier = modifiers.resourceYieldMultiplier ?? 1;
        this.regrowIntervalDays = 3;
    }

    onDayStart(dayNumber = 1) {
        if (!this.initialized) {
            this.generateNodes();
            this.initialized = true;
            this.lastRegrowDay = dayNumber;
            return;
        }

        const needsRegrow = dayNumber > this.lastRegrowDay && ((dayNumber - 1) % this.regrowIntervalDays === 0);
        if (needsRegrow) {
            for (const node of this.nodes) {
                node.amount = node.capacity;
                node.depleted = false;
            }
            this.lastRegrowDay = dayNumber;
        }
    }

    generateNodes() {
        this.nodes.length = 0;
        const types = Object.keys(RESOURCE_TYPES);
        const { resourceNodesPerType, resourceRadius } = this.worldSettings;
        const housePosition = this.world?.house?.position ?? this.worldSettings.housePosition;
        const width = this.world?.getWidth?.() ?? this.world?.baseWidth ?? housePosition.x * 2;
        const height = this.world?.getHeight?.() ?? this.world?.baseHeight ?? housePosition.y * 2;
        const margin = 140;

        for (const type of types) {
            const baseNodes = resourceNodesPerType;
            const totalNodes = type === "berries"
                ? Math.max(3, Math.round(baseNodes * 0.5))
                : baseNodes;
            const nearHouseNodes = Math.max(1, Math.floor(totalNodes / 3));

            for (let i = 0; i < totalNodes; i++) {
                let position;
                if (i < nearHouseNodes) {
                    const offset = randomInCircle(resourceRadius);
                    position = {
                        x: housePosition.x + offset.x,
                        y: housePosition.y + offset.y
                    };
                } else {
                    position = {
                        x: margin + Math.random() * (width - margin * 2),
                        y: margin + Math.random() * (height - margin * 2)
                    };
                }

                position.x = clamp(position.x, margin, width - margin);
                position.y = clamp(position.y, margin, height - margin);
                const capacity = NODE_CAPACITY[type] || 30;
                const reward = HARVEST_REWARD[type] ?? capacity;
                this.nodes.push({
                    id: `${type}-${i}-${Date.now()}-${Math.random()}`,
                    type,
                    capacity,
                    amount: capacity,
                    reward,
                    depleted: false,
                    position
                });
            }
        }
    }

    findGatherableNode(target, range = GATHER_RANGE) {
        const position = target?.position ?? target;
        if (!position) {
            return null;
        }
        for (const node of this.nodes) {
            if (node.depleted) continue;
            if (distance(position, node.position) <= range) {
                return node;
            }
        }
        return null;
    }

    attemptGather(player) {
        const range = GATHER_RANGE;
        for (const node of this.nodes) {
            if (node.depleted) continue;
            if (distance(player.position, node.position) > range) continue;

            const type = node.type;
            const gatherMultiplier = player?.getGatherMultiplier?.() ?? 1;
            const isBerryNode = type === "berries";

            if (player?.startSwing) {
                const baseDuration = Number.isFinite(player.swingDuration) ? player.swingDuration : undefined;
                const duration = baseDuration ? baseDuration * (isBerryNode ? 0.92 : 1.15) : undefined;
                player.startSwing({
                    duration,
                    anchor: node.position
                });
            }

            if (isBerryNode && !this.inventory.canAddItem(createBerryItem(1))) {
                const progress = 1 - node.amount / node.capacity;
                return {
                    type,
                    rewardAmount: 0,
                    rewarded: false,
                    progress,
                    remaining: node.amount,
                    capacity: node.capacity,
                    depleted: false,
                    position: { ...node.position },
                    failureReason: "inventory-full"
                };
            }
            const work = (GATHER_AMOUNT[type] ?? 1) * gatherMultiplier;
            node.amount = Math.max(0, node.amount - work);
            const progress = 1 - node.amount / node.capacity;

            if (node.amount <= 0) {
                node.depleted = true;
                if (isBerryNode) {
                    const baseRoll = Math.random() < 0.5 ? 1 : 2;
                    const scaled = Math.round(baseRoll * (this.resourceYieldMultiplier ?? 1) * gatherMultiplier);
                    const rewardAmount = Math.min(2, Math.max(1, scaled));
                    const berryItem = createBerryItem(rewardAmount);
                    const added = this.inventory.addItem(berryItem);
                    if (!added) {
                        node.depleted = false;
                        const restoreAmount = Math.ceil(Math.max(work, node.capacity * 0.25));
                        node.amount = Math.max(restoreAmount, 1);
                        const retryProgress = 1 - node.amount / node.capacity;
                        return {
                            type,
                            rewardAmount: 0,
                            rewarded: false,
                            progress: retryProgress,
                            remaining: node.amount,
                            capacity: node.capacity,
                            depleted: false,
                            position: { ...node.position },
                            failureReason: "inventory-full"
                        };
                    }
                    const total = this.inventory.countStack(BERRY_STACK_KEY);
                    return {
                        type,
                        rewardAmount,
                        rewarded: true,
                        total,
                        progress: 1,
                        remaining: node.amount,
                        capacity: node.capacity,
                        depleted: true,
                        position: { ...node.position }
                    };
                }
                const baseReward = HARVEST_REWARD[type] ?? 0;
                const rewardAmount = baseReward > 0
                    ? Math.max(1, Math.round(baseReward * this.resourceYieldMultiplier * gatherMultiplier))
                    : 0;
                let total = null;
                if (rewardAmount > 0) {
                    total = this.inventory.addResource(type, rewardAmount);
                }
                return {
                    type,
                    rewardAmount,
                    rewarded: rewardAmount > 0,
                    total,
                    progress: 1,
                    remaining: node.amount,
                    capacity: node.capacity,
                    depleted: true,
                    position: { ...node.position }
                };
            }

            return {
                type,
                rewardAmount: 0,
                rewarded: false,
                progress,
                remaining: node.amount,
                capacity: node.capacity,
                depleted: false,
                position: { ...node.position }
            };
        }
        return null;
    }

    drawNodes(ctx, camera) {
        for (const node of this.nodes) {
            let spriteKey = null;
            switch (node.type) {
                case "wood":
                    spriteKey = "tree";
                    break;
                case "stone":
                    spriteKey = "rock";
                    break;
                case "metal":
                    spriteKey = "metal";
                    break;
                case "berries":
                    spriteKey = node.amount > 0 ? "berryBush" : "bush";
                    break;
                default:
                    spriteKey = null;
                    break;
            }

            const asset = spriteKey ? getAsset(spriteKey) : null;
            const drawSize = NODE_DRAW_SIZE[node.type] || 64;
            const drawX = node.position.x - camera.x;
            const drawY = node.position.y - camera.y;
            const depleted = node.amount <= 0;
            const shouldFade = depleted && spriteKey !== "bush";

            if (asset?.loaded) {
                const aspect = asset.image.width / asset.image.height;
                const width = drawSize;
                const height = width / aspect;
                ctx.save();
                if (shouldFade) {
                    ctx.globalAlpha = 0.25;
                }
                ctx.drawImage(
                    asset.image,
                    drawX - width / 2,
                    drawY - height / 2,
                    width,
                    height
                );
                ctx.restore();
            } else {
                let fillColor = "#3f6f9f";
                if (node.type === "wood") {
                    fillColor = "#2f6f35";
                } else if (node.type === "stone") {
                    fillColor = "#6f6f6f";
                } else if (node.type === "berries") {
                    fillColor = depleted ? "#3c5f38" : "#b24c80";
                }
                ctx.fillStyle = depleted && node.type !== "berries" ? "#2c2c2c" : fillColor;
                ctx.beginPath();
                ctx.arc(drawX, drawY, drawSize / 2.4, 0, Math.PI * 2);
                ctx.fill();
            }

            ctx.fillStyle = "rgba(0,0,0,0.45)";
            ctx.fillRect(drawX - 24, drawY + drawSize / 2 - 6, 48, 5);
            if (!depleted) {
                const ratio = node.amount / node.capacity;
                ctx.fillStyle = node.type === "berries"
                    ? "rgba(212, 109, 170, 0.85)"
                    : "rgba(220, 220, 220, 0.8)";
                ctx.fillRect(drawX - 24, drawY + drawSize / 2 - 6, 48 * ratio, 5);
            }
        }
    }
}

