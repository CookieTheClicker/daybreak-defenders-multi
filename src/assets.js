// Asset loading helpers for optional sprite props dropped into assets/props.
const COMPUTER_DATA_URI = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='44' rx='6' ry='6' fill='%231c2533'/><rect x='8' y='10' width='48' height='26' rx='3' ry='3' fill='%230a84ff'/><rect x='18' y='44' width='28' height='6' rx='2' ry='2' fill='%233b4658'/><rect x='14' y='50' width='36' height='6' rx='3' ry='3' fill='%23202733'/></svg>";
export const PROP_REGISTRY = {
    player: "assets/props/player.png",
    enemy: "assets/props/enemy.png",
    house: "assets/props/house.png",
    tree: "assets/props/tree.png",
    rock: "assets/props/rock.png",
    metal: "assets/props/metal.png",
    barricade: "assets/props/barricade.png",
    spike: "assets/props/spike.png",
    turret: "assets/props/turret.png",
    craftingTable: "assets/props/crafting-table.png",
    woodResource: "assets/props/log.png",
    stoneResource: "assets/props/rock.png",
    metalResource: "assets/props/metal.png",
    berryBush: "assets/props/berry-bush.png",
    berryItem: "assets/props/berries.png",
    bush: "assets/props/bush.png",
    chest: "assets/props/chest.png",
    openChest: "assets/props/open-chest.png",
    hatchet: "assets/props/hatchet.png",
    hatchetIcon: "assets/props/hatchet-icon.png",
    blade: "assets/props/sharp-blade.png",
    bladeIcon: "assets/props/sharp-blade-icon.png",
    spear: "assets/props/sunforged-spear.png",
    spearIcon: "assets/props/sunforged-spear-icon.png",
    leatherArmor: "assets/props/leather-armor.png",
    leatherArmorIcon: "assets/props/leather-armor-icon.png",
    ironArmor: "assets/props/iron-armor.png",
    ironArmorIcon: "assets/props/iron-armor-icon.png",
    gemstoneArmor: "assets/props/gemstone-armor.png",
    gemstoneArmorIcon: "assets/props/gemstone-armor-icon.png",
    woodenPickaxe: "assets/props/wooden-pickaxe.png",
    woodenPickaxeIcon: "assets/props/wooden-pickaxe-icon.png",
    metalPickaxe: "assets/props/metal-pickaxe.png",
    metalPickaxeIcon: "assets/props/metal-pickaxe-icon.png",
    gemstonePickaxe: "assets/props/gemstone-pickaxe.png",
    gemstonePickaxeIcon: "assets/props/gemstone-pickaxe-icon.png",
    computer: COMPUTER_DATA_URI
};

const STRUCTURE_ICON_MAP = {
    barricade: PROP_REGISTRY.barricade,
    spike: PROP_REGISTRY.spike,
    turret: PROP_REGISTRY.turret,
    computer: PROP_REGISTRY.computer
};

const ITEM_ICON_MAP = {
    "Rusty Hatchet": PROP_REGISTRY.hatchetIcon,
    "Sharp Blade": PROP_REGISTRY.bladeIcon,
    "Sunforged Spear": PROP_REGISTRY.spearIcon,
    "Wooden Pickaxe": PROP_REGISTRY.woodenPickaxeIcon,
    "Metal Pickaxe": PROP_REGISTRY.metalPickaxeIcon,
    "Gemstone Pickaxe": PROP_REGISTRY.gemstonePickaxeIcon,
    "Leather Armor": PROP_REGISTRY.leatherArmorIcon,
    "Iron Armor": PROP_REGISTRY.ironArmorIcon,
    "Gemstone Armor": PROP_REGISTRY.gemstoneArmorIcon
};

const ITEM_WORLD_ASSET_MAP = {
    "Rusty Hatchet": "hatchet",
    "Sharp Blade": "blade",
    "Sunforged Spear": "spear",
    "Wooden Pickaxe": "woodenPickaxe",
    "Metal Pickaxe": "metalPickaxe",
    "Gemstone Pickaxe": "gemstonePickaxe"
};

const ITEM_WORLD_SCALE_MAP = {
    "Rusty Hatchet": 30,
    "Sharp Blade": 34,
    "Sunforged Spear": 40,
    "Wooden Pickaxe": 34,
    "Metal Pickaxe": 34,
    "Gemstone Pickaxe": 36
};

const assetCache = new Map();

function loadImage(path) {
    return new Promise((resolve) => {
        const image = new Image();
        image.onload = () => resolve({ loaded: true, image });
        image.onerror = () => resolve({ loaded: false, image: null });
        image.src = path;
    });
}

export async function loadAssets(keys = Object.keys(PROP_REGISTRY)) {
    const entries = await Promise.all(
        keys.map(async (key) => {
            const path = PROP_REGISTRY[key];
            const result = await loadImage(path);
            const record = { key, path, ...result };
            if (!result.loaded) {
                console.warn(`[assets] Failed to load asset '${key}' from ${path}`);
            }
            assetCache.set(key, record);
            return record;
        })
    );
    return entries;
}

export function getAsset(key) {
    return assetCache.get(key) || null;
}

export function resolveItemIconPath(itemOrName) {
    if (!itemOrName) {
        return null;
    }
    if (typeof itemOrName === "string") {
        return ITEM_ICON_MAP[itemOrName] ?? null;
    }
    return itemOrName.iconPath
        ?? (itemOrName.category === "structure-kit" ? resolveStructureIconPath(itemOrName) : null)
        ?? ITEM_ICON_MAP[itemOrName.name]
        ?? null;
}

export function resolveItemWorldAsset(itemOrName) {
    if (!itemOrName) {
        return null;
    }
    if (typeof itemOrName === "string") {
        return ITEM_WORLD_ASSET_MAP[itemOrName] ?? null;
    }
    return itemOrName.worldAssetKey
        ?? ITEM_WORLD_ASSET_MAP[itemOrName.name]
        ?? null;
}

export function resolveItemWorldScale(itemOrName) {
    if (!itemOrName) {
        return null;
    }
    if (typeof itemOrName === "object" && itemOrName.worldScale) {
        return itemOrName.worldScale;
    }
    const name = typeof itemOrName === "string" ? itemOrName : itemOrName.name;
    return ITEM_WORLD_SCALE_MAP[name] ?? null;
}

export function createImagePlaceholders(keys = Object.keys(PROP_REGISTRY)) {
    const images = new Map();
    for (const key of keys) {
        images.set(key, assetCache.get(key) || {
            key,
            path: PROP_REGISTRY[key],
            loaded: false,
            image: null
        });
    }
    return images;
}

export function resolveStructureIconPath(target) {
    if (!target) {
        return null;
    }
    const typeKey = typeof target === "string"
        ? target
        : target.structureType ?? target.key ?? target.name ?? null;
    if (!typeKey) {
        return null;
    }
    return STRUCTURE_ICON_MAP[typeKey] ?? null;
}
