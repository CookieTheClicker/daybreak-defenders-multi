import { STRUCTURE_TYPES } from "./constants.js";
import { getAsset, resolveItemIconPath, resolveItemWorldAsset, resolveItemWorldScale, resolveStructureIconPath } from "./assets.js";
import { distance, clamp } from "./utils.js";
import { createBerryItem } from "./inventory.js";
import { random, randomId } from "./rng.js";

const CHEST_TYPES = [
    { key: "common", weight: 1, rolls: [1, 2], color: "#c49b66" },
    { key: "rare", weight: 0.58, rolls: [2, 3], color: "#7d9fff" },
    { key: "legendary", weight: 0.28, rolls: [3, 4], color: "#c46dd6" }
];

const RESOURCE_LOOT = [
    { resource: "wood", min: 24, max: 72, weight: 16 },
    { resource: "stone", min: 18, max: 56, weight: 14 },
    { resource: "metal", min: 14, max: 46, weight: 13 },
    { resource: "berries", min: 12, max: 32, weight: 10 }
];

const WEAPON_LOOT = [
    { name: "Rusty Hatchet", attackBonus: 6, weight: 10, tier: 1, icon: "[W]", worldAssetKey: "hatchet", iconPath: "assets/props/hatchet-icon.png", worldScale: 30 },
    { name: "Sharp Blade", attackBonus: 10, weight: 7, tier: 2, icon: "[W]", worldAssetKey: "blade", iconPath: "assets/props/sharp-blade-icon.png", worldScale: 34 },
    { name: "Sunforged Spear", attackBonus: 16, weight: 4, tier: 3, icon: "[W]", worldAssetKey: "spear", iconPath: "assets/props/sunforged-spear-icon.png", worldScale: 40 }
];

const ARMOR_LOOT = [
    { name: "Leather Armor", damageReduction: 0.12, weight: 10, tier: 1, icon: "--", iconPath: "assets/props/leather-armor-icon.png", overlayKey: "leatherArmor", overlayColor: "rgba(184, 216, 255, 0.9)" },
    { name: "Iron Armor", damageReduction: 0.18, weight: 7, tier: 2, icon: "--", iconPath: "assets/props/iron-armor-icon.png", overlayKey: "ironArmor", overlayColor: "rgba(161, 206, 255, 0.9)" },
    { name: "Gemstone Armor", damageReduction: 0.26, weight: 4, tier: 3, icon: "--", iconPath: "assets/props/gemstone-armor-icon.png", overlayKey: "gemstoneArmor", overlayColor: "rgba(181, 226, 255, 0.95)" }
];

const TOOL_LOOT = [
    { name: "Wooden Pickaxe", gatherBonus: 1.12, weight: 10, tier: 1, icon: "//", iconPath: "assets/props/wooden-pickaxe-icon.png", worldAssetKey: "woodenPickaxe", worldScale: 34 },
    { name: "Metal Pickaxe", gatherBonus: 1.25, weight: 7, tier: 2, icon: "//", iconPath: "assets/props/metal-pickaxe-icon.png", worldAssetKey: "metalPickaxe", worldScale: 34 },
    { name: "Gemstone Pickaxe", gatherBonus: 1.45, weight: 4, tier: 3, icon: "//", iconPath: "assets/props/gemstone-pickaxe-icon.png", worldAssetKey: "gemstonePickaxe", worldScale: 36 }
];

const KIT_LOOT = [
    { structureType: "barricade", count: 1, weight: 8 },
    { structureType: "spike", count: 1, weight: 6 },
    { structureType: "turret", count: 1, weight: 3 }
];

function pickWeighted(entries, qualityModifier = 1) {
    if (!entries.length) return null;
    const weightSum = entries.reduce((sum, entry, index) => {
        const tierBoost = entry.tier ? 1 + ((entry.tier - 1) * 0.35 * (qualityModifier - 1)) : 1;
        return sum + (entry.weight ?? 1) * tierBoost;
    }, 0);
    if (weightSum <= 0) {
        return entries[Math.floor(random() * entries.length)];
    }
    let pick = random() * weightSum;
    for (const entry of entries) {
        const tierBoost = entry.tier ? 1 + ((entry.tier - 1) * 0.35 * (qualityModifier - 1)) : 1;
        const weight = (entry.weight ?? 1) * tierBoost;
        if (pick <= weight) {
            return entry;
        }
        pick -= weight;
    }
    return entries[entries.length - 1];
}

function rollResource(modifiers) {
    const entry = pickWeighted(RESOURCE_LOOT, modifiers.lootQualityModifier ?? 1);
    if (!entry) {
        return null;
    }
    const amount = Math.round((entry.min + random() * (entry.max - entry.min)) * (modifiers.resourceYield ?? 1));
    return {
        type: "resource",
        resource: entry.resource,
        amount: Math.max(amount, entry.min)
    };
}

function rollWeapon(modifiers) {
    const entry = pickWeighted(WEAPON_LOOT, modifiers.lootQualityModifier ?? 1);
    if (!entry) {
        return null;
    }
    return {
        type: "equipment",
        slot: "weapon",
        name: entry.name,
        attackBonus: entry.attackBonus,
        rarity: entry.tier,
        icon: entry.icon || "[W]"
    };
}

function rollArmor(modifiers) {
    const entry = pickWeighted(ARMOR_LOOT, modifiers.lootQualityModifier ?? 1);
    if (!entry) {
        return null;
    }
    return {
        type: "equipment",
        slot: "armor",
        name: entry.name,
        damageReduction: entry.damageReduction,
        rarity: entry.tier,
        icon: entry.icon || "--",
        overlayKey: entry.overlayKey,
        overlayColor: entry.overlayColor
    };
}

function rollTool(modifiers) {
    const entry = pickWeighted(TOOL_LOOT, modifiers.lootQualityModifier ?? 1);
    if (!entry) {
        return null;
    }
    return {
        type: "equipment",
        slot: "tool",
        name: entry.name,
        gatherBonus: entry.gatherBonus,
        rarity: entry.tier,
        icon: entry.icon || "//"
    };
}

function rollKit(modifiers) {
    const entry = pickWeighted(KIT_LOOT, modifiers.lootQualityModifier ?? 1.05);
    if (!entry) {
        return null;
    }
    const structure = STRUCTURE_TYPES[entry.structureType];
    const label = structure ? structure.key : entry.structureType;
    return {
        type: "kit",
        structureType: entry.structureType,
        count: entry.count,
        name: `${label.charAt(0).toUpperCase()}${label.slice(1)} Kit`,
        icon: "[K]",
        iconPath: resolveStructureIconPath(entry.structureType)
    };
}

function clampToWorld(position, world) {
    const width = world?.getWidth?.() ?? 0;
    const height = world?.getHeight?.() ?? 0;
    const margin = 64;
    return {
        x: clamp(position.x, margin, width - margin),
        y: clamp(position.y, margin, height - margin)
    };
}

function randomPosition(world) {
    const width = world.getWidth();
    const height = world.getHeight();
    const margin = 120;
    return {
        x: margin + random() * (width - margin * 2),
        y: margin + random() * (height - margin * 2)
    };
}

function chestColor(key) {
    const record = CHEST_TYPES.find((type) => type.key === key);
    return record?.color ?? "#c49b66";
}

export class LootManager {
    constructor(world, modifiers = {}) {
        this.world = world;
        this.modifiers = {
            lootQualityModifier: modifiers.lootQualityModifier ?? 1,
            resourceYield: modifiers.resourceYield ?? 1
        };
        this.spawnRadiusFromHouse = 200;
        this.maxInitialChests = 8;
        this.initialized = false;
        this.chests = [];
        this.generateInitialChests();
    }

    setModifiers(modifiers = {}) {
        this.modifiers.lootQualityModifier = modifiers.lootQualityModifier ?? this.modifiers.lootQualityModifier ?? 1;
        this.modifiers.resourceYield = modifiers.resourceYield ?? this.modifiers.resourceYield ?? 1;
    }

    generateInitialChests() {
        if (!this.world) {
            return;
        }
        this.chests = [];
        const house = this.world.house?.position ?? { x: this.world.getWidth() / 2, y: this.world.getHeight() / 2 };
        for (let i = 0; i < this.maxInitialChests; i++) {
            this.chests.push(this.createChest(this.modifiers, house));
        }
        this.initialized = true;
    }

    createChest(modifiers, housePosition) {
        const type = rollChestType(modifiers);
        let position = randomPosition(this.world);
        let attempts = 10;
        while (attempts-- > 0 && distance(position, housePosition) < this.spawnRadiusFromHouse) {
            position = randomPosition(this.world);
        }
        position = clampToWorld(position, this.world);
        return {
            id: randomId("chest"),
            type: type.key,
            position,
            opened: false,
            loot: rollChestLoot(type, this.modifiers),
            openedAt: 0
        };
    }

    onDayStart(dayNumber) {
        if (!this.initialized) {
            this.generateInitialChests();
            return;
        }
        if (dayNumber > 1 && (dayNumber - 1) % 3 === 0) {
            this.spawnExtraChests(2);
        }
    }

    onMapExpanded() {
        this.spawnExtraChests(3);
    }

    spawnExtraChests(count = 1) {
        if (!this.world) {
            return;
        }
        const house = this.world.house?.position ?? { x: this.world.getWidth() / 2, y: this.world.getHeight() / 2 };
        for (let i = 0; i < count; i++) {
            this.chests.push(this.createChest(this.modifiers, house));
        }
    }

    findNearby(position, radius = 72) {
        for (const chest of this.chests) {
            if (chest.opened) continue;
            if (distance(position, chest.position) <= radius) {
                return chest;
            }
        }
        return null;
    }

    openChest(chest, context) {
        if (!chest || chest.opened) {
            return null;
        }
        const { inventory, player, ui, effects } = context;
        const rewards = [];
        for (const entry of chest.loot) {
            if (entry.type === "resource") {
                if (entry.resource === "berries") {
                    const berryItem = createBerryItem(entry.amount);
                    const addedBerry = inventory.addItem(berryItem);
                    if (addedBerry) {
                        rewards.push({ kind: "berry", item: addedBerry });
                    } else {
                        rewards.push({ kind: "item-denied", item: berryItem });
                    }
                    continue;
                }
                const total = inventory.addResource(entry.resource, entry.amount);
                rewards.push({ kind: "resource", resource: entry.resource, amount: entry.amount, total });
                continue;
            }

            if (entry.type === "kit") {
                const item = {
                    name: entry.name,
                    description: `Deploy a ${entry.structureType} instantly.`,
                    category: "structure-kit",
                    structureType: entry.structureType,
                    count: entry.count,
                    icon: entry.icon,
                    iconPath: entry.iconPath ?? resolveStructureIconPath(entry.structureType)
                };
                if (!inventory.addItem(item)) {
                    rewards.push({ kind: "kit-denied", item });
                    continue;
                }
                rewards.push({ kind: "kit", item });
                continue;
            }

            if (entry.type === "equipment") {
                const item = buildEquipmentItem(entry);
                const added = inventory.addItem(item);
                rewards.push({ kind: "equipment", item, added });
            }
        }
        chest.opened = true;
        chest.openedAt = (performance?.now?.() ?? Date.now()) / 1000;

        const summary = rewards
            .map((reward) => summarizeReward(reward))
            .filter(Boolean)
            .join(", ");
        if (summary && ui?.showMessage) {
            ui.showMessage(`Chest loot: ${summary}`, 3, "#ffdd87");
        }
        if (effects?.spawnPulse) {
            effects.spawnPulse({
                position: { ...chest.position },
                startRadius: 18,
                endRadius: 90,
                color: "rgba(255, 220, 135, 0.35)"
            });
        }
        return rewards;
    }

    draw(ctx, camera, player) {
        for (const chest of this.chests) {
            const screenX = chest.position.x - camera.x;
            const screenY = chest.position.y - camera.y;
            const asset = getAsset(chest.opened ? "openChest" : "chest");
            const size = 36;
            if (asset?.loaded) {
                const aspect = asset.image.width / asset.image.height;
                const width = size;
                const height = width / aspect;
                ctx.save();
                if (chest.opened) {
                    ctx.globalAlpha = 0.45;
                }
                ctx.drawImage(asset.image, screenX - width / 2, screenY - height / 2, width, height);
                ctx.restore();
            } else {
                ctx.save();
                ctx.fillStyle = chest.opened ? "rgba(96, 108, 128, 0.45)" : chestColor(chest.type);
                ctx.strokeStyle = "rgba(12, 12, 18, 0.75)";
                ctx.lineWidth = 3;
                ctx.beginPath();
                ctx.roundRect(screenX - size / 2, screenY - size / 2, size, size, 6);
                ctx.fill();
                ctx.stroke();
                ctx.restore();
            }
            if (!chest.opened && player?.position && distance(player.position, chest.position) <= 80) {
                ctx.save();
                ctx.fillStyle = "rgba(12, 18, 26, 0.6)";
                ctx.fillRect(screenX - 64, screenY - 44, 128, 26);
                ctx.fillStyle = "#f0f6ff";
                ctx.font = "15px Segoe UI";
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText("Press E to loot", screenX, screenY - 30);
                ctx.restore();
            }
        }
    }
}

function rollChestType(modifiers) {
    const quality = modifiers.lootQualityModifier ?? 1;
    const adjusted = CHEST_TYPES.map((type, index) => {
        const boost = 1 + index * 0.35 * (quality - 1);
        return { ...type, effective: (type.weight ?? 1) * boost };
    });
    const total = adjusted.reduce((sum, type) => sum + type.effective, 0);
    // Use Math.random here so chest type varies between clients even with same seed
    let pick = Math.random() * total;
    for (const type of adjusted) {
        if (pick <= type.effective) {
            return type;
        }
        pick -= type.effective;
    }
    return adjusted[0];
}

function rollChestLoot(chestType, modifiers) {
    const [minRolls, maxRolls] = chestType.rolls;
    // Use Math.random here so chest contents are not identical across clients
    const rolls = Math.max(minRolls, Math.ceil(minRolls + Math.random() * (maxRolls - minRolls)));
    const loot = [];
    for (let i = 0; i < rolls; i++) {
        const categoryRoll = Math.random();
        let entry = null;
        if (categoryRoll < 0.45) {
            entry = rollResource(modifiers);
        } else if (categoryRoll < 0.85) {
            const equipmentRoll = Math.random();
            if (equipmentRoll < 0.33) {
                entry = rollWeapon(modifiers);
            } else if (equipmentRoll < 0.66) {
                entry = rollArmor(modifiers);
            } else {
                entry = rollTool(modifiers);
            }
        } else {
            entry = rollKit(modifiers);
        }
        if (entry) {
            loot.push(entry);
        }
    }
    return loot;
}

function buildEquipmentItem(entry) {
    if (entry.slot === "weapon") {
        return {
            name: entry.name,
            description: `+${entry.attackBonus} attack damage`,
            category: "equipment",
            slot: "weapon",
            attackBonus: entry.attackBonus ?? 0,
            rarity: entry.rarity ?? 1,
            icon: entry.icon,
            iconPath: resolveItemIconPath(entry),
            worldAssetKey: resolveItemWorldAsset(entry),
            worldScale: resolveItemWorldScale(entry)
        };
    }
    if (entry.slot === "armor") {
        const reductionPercent = Math.round((entry.damageReduction ?? 0) * 100);
        return {
            name: entry.name,
            description: `${reductionPercent}% damage reduction`,
            category: "equipment",
            slot: "armor",
            damageReduction: entry.damageReduction ?? 0,
            rarity: entry.rarity ?? 1,
            icon: entry.icon,
            iconPath: resolveItemIconPath(entry),
            overlayKey: entry.overlayKey,
            overlayColor: entry.overlayColor
        };
    }
    if (entry.slot === "tool") {
        const bonusPercent = Math.round(((entry.gatherBonus ?? 1) - 1) * 100);
        return {
            name: entry.name,
            description: bonusPercent > 0 ? `+${bonusPercent}% gathering yield` : "Reliable gathering tool",
            category: "equipment",
            slot: "tool",
            gatherBonus: entry.gatherBonus ?? 1,
            rarity: entry.rarity ?? 1,
            icon: entry.icon,
            iconPath: resolveItemIconPath(entry),
            worldAssetKey: resolveItemWorldAsset(entry),
            worldScale: resolveItemWorldScale(entry)
        };
    }
    return { ...entry, category: "equipment" };
}

function summarizeReward(reward) {
    if (!reward) {
        return null;
    }
    switch (reward.kind) {
        case "resource": {
            const label = reward.resource.charAt(0).toUpperCase() + reward.resource.slice(1);
            return `+${reward.amount} ${label}`;
        }
        case "berry":
            return `+${reward.item?.count ?? 1} Berries`;
        case "equipment":
            return reward.item?.name ?? null;
        case "kit":
            return reward.item?.name ?? null;
        case "kit-denied":
            return null;
        default:
            return null;
    }
}
