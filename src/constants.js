export const CANVAS_WIDTH = 1280;
export const CANVAS_HEIGHT = 896;
export const MAP_WIDTH = 2560;
export const MAP_HEIGHT = 1920;
export const MAP_EXPANSION_INTERVAL_DAYS = 3;
export const MAP_EXPANSION_WIDTH = 480;
export const MAP_EXPANSION_HEIGHT = 360;
export const DAY_LENGTH_SECONDS = 75;
export const NIGHT_LENGTH_SECONDS = 52;
export const HOUSE_START_HP = 120;
export const PLAYER_SPEED = 180;
export const PLAYER_SPRINT_MULTIPLIER = 1.55;
export const PLAYER_MAX_HEALTH = 120;
export const PLAYER_MELEE_DAMAGE = 22;
export const PLAYER_MELEE_COOLDOWN = 0.45;


export const INVENTORY_ITEM_CAPACITY = 24;

export const RESOURCE_TYPES = {
    wood: { name: "Wood", color: "#3b873e" },
    stone: { name: "Stone", color: "#b1b1b1" },
    metal: { name: "Metal", color: "#a6c5ff" },
    berries: { name: "Berries", color: "#d46daa" }
};

export const STRUCTURE_TYPES = {
    barricade: {
        key: "barricade",
        cost: { wood: 14, stone: 6, metal: 0 },
        maxHp: 190,
        size: 52,
        color: "#6b4f31"
    },
    spike: {
        key: "spike",
        cost: { wood: 10, stone: 5, metal: 0 },
        maxHp: 90,
        size: 52,
        color: "#9b2e1f",
        damagePerSecond: 34
    },
    turret: {
        key: "turret",
        cost: { wood: 8, stone: 12, metal: 14 },
        maxHp: 140,
        size: 80,
        color: "#506773",
        range: 240,
        fireRate: 1.25,
        damage: 14
    }
};

export const ENEMY_STATS = {
    baseSpeed: 54,
    baseHealth: 70,
    baseDamage: 7,
    damageInterval: 1.05
};

export const DIFFICULTY_PRESETS = {
    easy: {
        key: "easy",
        label: "Easy",
        enemyDamageMultiplier: 0.7,
        enemyHealthMultiplier: 0.85,
        enemySpeedMultiplier: 0.85,
        spawnMultiplier: 0.8,
        playerHealth: 160,
        playerDamageMultiplier: 1.1,
        baseDamageReduction: 0.05,
        resourceYieldMultiplier: 1.25,
        gatherMultiplier: 1.05,
        lootQualityModifier: 1.2
    },
    normal: {
        key: "normal",
        label: "Normal",
        enemyDamageMultiplier: 1,
        enemyHealthMultiplier: 1,
        enemySpeedMultiplier: 1,
        spawnMultiplier: 1,
        playerHealth: PLAYER_MAX_HEALTH,
        playerDamageMultiplier: 1,
        baseDamageReduction: 0,
        resourceYieldMultiplier: 1,
        gatherMultiplier: 1,
        lootQualityModifier: 1
    },
    hard: {
        key: "hard",
        label: "Hard",
        enemyDamageMultiplier: 1.25,
        enemyHealthMultiplier: 1.2,
        enemySpeedMultiplier: 1.15,
        spawnMultiplier: 1.2,
        playerHealth: 100,
        playerDamageMultiplier: 0.95,
        baseDamageReduction: 0.02,
        resourceYieldMultiplier: 0.9,
        gatherMultiplier: 0.95,
        lootQualityModifier: 1.1
    },
    insane: {
        key: "insane",
        label: "Insane",
        enemyDamageMultiplier: 1.6,
        enemyHealthMultiplier: 1.45,
        enemySpeedMultiplier: 1.35,
        spawnMultiplier: 1.35,
        playerHealth: 80,
        playerDamageMultiplier: 0.9,
        baseDamageReduction: 0,
        resourceYieldMultiplier: 0.8,
        gatherMultiplier: 0.9,
        lootQualityModifier: 1.25
    }
};

export const DEFAULT_DIFFICULTY = "normal";


export const WORLD_SETTINGS = {
    housePosition: { x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2 },
    resourceRadius: 520,
    resourceNodesPerType: 11
};
