import {
    CANVAS_WIDTH,
    CANVAS_HEIGHT,
    DAY_LENGTH_SECONDS,
    NIGHT_LENGTH_SECONDS,
    MAP_EXPANSION_INTERVAL_DAYS,
    STRUCTURE_TYPES,
    DEFAULT_DIFFICULTY,
    DIFFICULTY_PRESETS
} from "./constants.js";
import { Player } from "./player.js";
import { ResourceManager } from "./resources.js";
import { StructureManager } from "./buildings.js";
import { EnemyWaveManager } from "./enemies.js";
import { World } from "./world.js";
import { initializeInput } from "./input.js";
import { UIManager } from "./ui.js";
import { Inventory, BERRY_STACK_KEY } from "./inventory.js";
import { LootManager } from "./loot.js";
import { EffectManager } from "./effects.js";
import { loadAssets, getAsset } from "./assets.js";
import { clamp } from "./utils.js";
import { setupMultiplayer } from "./multiplayer_integration_example.js";

const CRAFTABLE_STRUCTURES = ["barricade", "spike", "turret"];
const STRUCTURE_ICON_PATHS = {
    barricade: "assets/props/barricade.png",
    spike: "assets/props/spike.png",
    turret: "assets/props/turret.png"
};

function formatName(word = "") {
    if (!word) return "";
    return word.charAt(0).toUpperCase() + word.slice(1);
}

(async function init() {
    await loadAssets();

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
    let remotePlayers = {};
    const playerVelocity = { x: 0, y: 0 };
    const lastPlayerPosition = { x: player.position.x, y: player.position.y };

    setupMultiplayer(
        () => ({
            x: player.position.x,
            y: player.position.y,
            dir: Number.isFinite(player.lastAimAngle) ? player.lastAimAngle : 0,
            hp: Number.isFinite(player.health) ? player.health : 100,
            anim: player.swingTimer > 0 ? "attack" : "idle",
            vx: Number.isFinite(playerVelocity.x) ? playerVelocity.x : 0,
            vy: Number.isFinite(playerVelocity.y) ? playerVelocity.y : 0
        }),
        (peers) => {
            remotePlayers = peers ?? {};
        }
    );

    window.remotePlayers = () => remotePlayers;

    const inventory = new Inventory();
    const resources = new ResourceManager(inventory, world, undefined, {
        resourceYieldMultiplier: difficultySettings.resourceYieldMultiplier
    });
    const structures = new StructureManager(world);
    const enemyWaves = new EnemyWaveManager(difficultySettings);
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
    const startOverlay = document.getElementById("start-overlay");
    const difficultyButtons = startOverlay ? Array.from(startOverlay.querySelectorAll("[data-difficulty]")) : [];
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
        berryHintShown: false
    };


    let lastCraftingMenuSignature = null;

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
        }
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

    const interiorState = {
        position: { ...houseInterior.spawn },
        speed: 140
    };

    resources.onDayStart(gameState.dayNumber);
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
                if (gameState.awaitingDifficulty) {
                    beginGameWithDifficulty(key);
                } else {
                    applyDifficultySettings(key);
                }
            });
        });
        ui.showMessage("Select a difficulty to begin.", 4, "#dbe7ff");
    } else {
        gameState.paused = false;
        gameState.awaitingDifficulty = false;
    }

    if (restartButton) {
        restartButton.addEventListener("click", () => {
            window.location.reload();
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
    };
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
        if (input.interact) {
            const nearTable = isInsideCraftingZone(interiorState.position);
            const nearDoor = isInsideDoorZone(interiorState.position);
            if (nearTable) {
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
        if (input.buildSelection) {
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

        const waveEvents = enemyWaves.update(deltaSeconds, world, structures, inventory, effects, player, gameState.phase === "night");
        structures.update(deltaSeconds, enemyWaves.enemies, effects);
        effects.update(deltaSeconds);

        if (waveEvents?.playerHits?.length) {
            let totalDamage = 0;
            for (const hit of waveEvents.playerHits) {
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

        const offsetX = Math.floor((CANVAS_WIDTH - houseInterior.width) / 2);
        const offsetY = Math.floor((CANVAS_HEIGHT - houseInterior.height) / 2);

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
                enemy.draw(ctx, gameState.camera);
            }
            const pointer = { x: Number.isFinite(input.mouse.worldX) ? input.mouse.worldX : player.position.x, y: Number.isFinite(input.mouse.worldY) ? input.mouse.worldY : player.position.y };
            player.draw(ctx, gameState.camera, pointer);
            for (const [id, p] of Object.entries(remotePlayers)) {
                if (!p || (window.__MP__?.id && id === window.__MP__.id)) {
                    continue;
                }
                const drawX = (Number.isFinite(p.x) ? p.x : player.position.x) - gameState.camera.x;
                const drawY = (Number.isFinite(p.y) ? p.y : player.position.y) - gameState.camera.y;
                ctx.save();
                ctx.globalAlpha = 0.7;
                ctx.fillStyle = "#7be0a6";
                ctx.beginPath();
                ctx.arc(drawX, drawY, 10, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
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
})();








