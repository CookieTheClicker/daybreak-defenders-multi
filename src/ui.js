import { STRUCTURE_TYPES } from "./constants.js";
import { resolveItemIconPath, PROP_REGISTRY } from "./assets.js";

const DEFAULT_BUILD_MESSAGE = "No build selected. Select a structure kit from the hotbar.";

const STRUCTURE_ICON_PATHS = {
    barricade: "assets/props/barricade.png",
    spike: "assets/props/spike.png",
    turret: "assets/props/turret.png",
    computer: PROP_REGISTRY.computer
};


function capitalize(word) {
    if (!word) return "";
    return word.charAt(0).toUpperCase() + word.slice(1);
}

function formatStructureName(key) {
    return capitalize(key.replace(/-/g, " "));
}

function formatResourceName(key) {
    return capitalize(key);
}

export class UIManager {
    constructor() {
        this.elements = {
            wood: document.getElementById("hud-wood"),
            stone: document.getElementById("hud-stone"),
            metal: document.getElementById("hud-metal"),
            berries: document.getElementById("hud-berries"),
            health: document.getElementById("hud-health"),
            day: document.getElementById("hud-day"),
            time: document.getElementById("hud-time"),
            message: document.getElementById("hud-message"),
            inventoryPanel: document.getElementById("inventory-panel"),
            inventoryGrid: document.getElementById("inventory-grid"),
            inventoryBar: document.getElementById("inventory-bar-items"),
            inventoryBarContainer: document.getElementById("inventory-bar"),
            inventoryArmorSlot: document.getElementById("inventory-armor-slot"),
            buildStatus: document.getElementById("build-status"),
            craftingPanel: document.getElementById("crafting-panel"),
            craftingResources: document.getElementById("crafting-resources"),
            craftingOptions: document.getElementById("crafting-options"),
            playerHealthFill: document.getElementById("player-health-fill"),
            playerHealthValue: document.getElementById("player-health-value"),
            houseHealthFill: document.getElementById("house-health-fill"),
            houseHealthValue: document.getElementById("house-health-value"),
            playerVital: document.getElementById("player-vital"),
            houseVital: document.getElementById("house-vital")
        };

        this.onCraftRequest = null;
        this.onInventoryItemUse = null;
        this.onInventoryReorder = null;
        this.suppressInventoryClick = false;
        this.dragState = {
            activeIndex: null,
            source: null,
            slotType: null,
            equippedIndex: null,
            originElement: null,
            hoverElement: null,
            pointerId: null,
            pointerActive: false,
            startX: 0,
            startY: 0,
            moved: false,
            completed: false
        };

        const inventoryClickHandler = (event) => {
            if (this.suppressInventoryClick) {
                this.suppressInventoryClick = false;
                return;
            }
            const rawTarget = event.target;
            const slot = rawTarget instanceof Element ? rawTarget.closest(".inventory-slot[data-item-index]") : null;
            if (!slot) {
                return;
            }
            const index = Number.parseInt(slot.dataset.itemIndex ?? "", 10);
            if (!Number.isFinite(index) || index < 0) {
                return;
            }
            const source = slot.dataset.source || "grid";
            if (source === "equipment") {
                return;
            }
            if (typeof this.onInventoryItemUse === "function") {
                this.onInventoryItemUse({ index, source, event });
            }
        };

        const getSlotFromEvent = (event) => {
            const rawTarget = event.target;
            if (!(rawTarget instanceof Element)) {
                return null;
            }
            return rawTarget.closest(".inventory-slot[data-slot-index]");
        };

        const clearDragHover = () => {
            if (this.dragState.hoverElement) {
                this.dragState.hoverElement.classList.remove("drag-target");
                this.dragState.hoverElement = null;
            }
        };

        const setDragHover = (slot) => {
            if (this.dragState.hoverElement === slot) {
                return;
            }
            clearDragHover();
            if (slot) {
                slot.classList.add("drag-target");
                this.dragState.hoverElement = slot;
            }
        };

        const resetDragState = () => {
            if (this.dragState.originElement) {
                this.dragState.originElement.classList.remove("dragging");
            }
            clearDragHover();
            this.dragState.activeIndex = null;
            this.dragState.source = null;
            this.dragState.slotType = null;
            this.dragState.equippedIndex = null;
            this.dragState.originElement = null;
            this.dragState.hoverElement = null;
            this.dragState.pointerId = null;
            this.dragState.pointerActive = false;
            this.dragState.startX = 0;
            this.dragState.startY = 0;
            this.dragState.moved = false;
            this.dragState.completed = false;
        };

        const slotFromGlobalPoint = (clientX, clientY) => {
            if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) {
                return null;
            }
            if (typeof document === "undefined" || typeof document.elementFromPoint !== "function") {
                return null;
            }
            const element = document.elementFromPoint(clientX, clientY);
            if (!(element instanceof Element)) {
                return null;
            }
            return element.closest(".inventory-slot[data-slot-index]");
        };

        const findSlotFromPoint = (container, clientX, clientY) => {
            if (!(container instanceof Element)) {
                return slotFromGlobalPoint(clientX, clientY);
            }
            const slots = Array.from(container.querySelectorAll(".inventory-slot"));
            if (!slots.length) {
                return slotFromGlobalPoint(clientX, clientY);
            }
            let bestSlot = null;
            let bestDistance = Number.POSITIVE_INFINITY;
            for (const slot of slots) {
                const rect = slot.getBoundingClientRect();
                if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
                    return slot;
                }
                const centerX = rect.left + rect.width / 2;
                const centerY = rect.top + rect.height / 2;
                const distance = Math.hypot(centerX - clientX, centerY - clientY);
                if (distance < bestDistance) {
                    bestDistance = distance;
                    bestSlot = slot;
                }
            }
            return bestSlot;
        };

        const resolveSlotFromPoint = (clientX, clientY) => {
            let slot = slotFromGlobalPoint(clientX, clientY);
            if (!slot && this.elements.inventoryGrid) {
                slot = findSlotFromPoint(this.elements.inventoryGrid, clientX, clientY);
            }
            if (!slot && this.elements.inventoryBar) {
                slot = findSlotFromPoint(this.elements.inventoryBar, clientX, clientY);
            }
            if (!slot && this.elements.inventoryArmorSlot) {
                slot = findSlotFromPoint(this.elements.inventoryArmorSlot, clientX, clientY);
            }
            return slot;
        };

        const completeDrag = (slot, event) => {
            if (this.dragState.activeIndex === null || this.dragState.completed || !slot) {
                return false;
            }
            const fromIndex = this.dragState.activeIndex;
            const toIndex = Number.parseInt(slot.dataset.slotIndex ?? "", 10);
            const slotType = slot.dataset.slotType || null;
            if ((!Number.isFinite(toIndex) || toIndex < 0) && !slotType) {
                return false;
            }
            setDragHover(slot);
            const details = {
                fromIndex,
                toIndex: Number.isFinite(toIndex) && toIndex >= 0 ? toIndex : null,
                source: this.dragState.source || "grid",
                target: slot.dataset.source || "grid",
                slotType,
                fromSlotType: this.dragState.slotType || null,
                fromEquippedIndex: Number.isFinite(this.dragState.equippedIndex) ? this.dragState.equippedIndex : null,
                event
            };
            console.debug('[UI] completeDrag details', details);
            if (typeof this.onInventoryReorder === "function") {
                try {
                    this.onInventoryReorder(details);
                } catch (err) {
                    console.error('[UI] onInventoryReorder handler error', err);
                }
            }
            this.dragState.completed = true;
            this.suppressInventoryClick = true;
            return true;
        };

        const removePointerListeners = () => {
            window.removeEventListener("pointermove", handlePointerMove);
            window.removeEventListener("pointerup", handlePointerUp);
            window.removeEventListener("pointercancel", handlePointerCancel);
        };

        const handlePointerMove = (event) => {
            if (!this.dragState.pointerActive || event.pointerId !== this.dragState.pointerId) {
                return;
            }
            const deltaX = Math.abs(event.clientX - this.dragState.startX);
            const deltaY = Math.abs(event.clientY - this.dragState.startY);
            if (!this.dragState.moved && (deltaX > 3 || deltaY > 3)) {
                this.dragState.moved = true;
                if (this.dragState.originElement) {
                    this.dragState.originElement.classList.add("dragging");
                }
            }
            if (!this.dragState.moved) {
                return;
            }
            event.preventDefault();
            const slot = resolveSlotFromPoint(event.clientX, event.clientY);
            if (slot) {
                setDragHover(slot);
            } else {
                clearDragHover();
            }
        };

        const finishPointerDrag = (event, attemptDrop = false) => {
            removePointerListeners();
            if (attemptDrop && this.dragState.moved) {
                const slot = resolveSlotFromPoint(event.clientX, event.clientY) || this.dragState.hoverElement;
                if (slot) {
                    completeDrag(slot, event);
                }
            }
            resetDragState();
        };

        const handlePointerUp = (event) => {
            if (!this.dragState.pointerActive || event.pointerId !== this.dragState.pointerId) {
                return;
            }
            finishPointerDrag(event, true);
        };

        const handlePointerCancel = (event) => {
            if (!this.dragState.pointerActive || event.pointerId !== this.dragState.pointerId) {
                return;
            }
            finishPointerDrag(event, false);
        };

        const handlePointerDown = (event) => {
            if (event.button !== undefined && event.button !== 0 && event.pointerType !== "touch") {
                return;
            }
            const slot = getSlotFromEvent(event);
            if (!slot) {
                return;
            }
            const hasItemIndexAttr = slot.hasAttribute("data-item-index");
            const hasEquippedIndexAttr = slot.hasAttribute("data-equipped-index");
            const rawIndex = Number.parseInt(slot.dataset.itemIndex ?? "", 10);
            const equipIndex = Number.parseInt(slot.dataset.equippedIndex ?? "", 10);
            const slotType = slot.dataset.slotType || null;
            if (slotType && !hasItemIndexAttr && !hasEquippedIndexAttr) {
                return;
            }
            let activeIndex = Number.isFinite(rawIndex) ? rawIndex : null;
            if ((activeIndex === null || activeIndex < 0) && Number.isFinite(equipIndex)) {
                activeIndex = equipIndex;
            }
            if (activeIndex === null && !slotType) {
                return;
            }
            if (!Number.isFinite(activeIndex)) {
                activeIndex = -1;
            }
            if (activeIndex < 0 && !slotType) {
                return;
            }
            this.dragState.pointerActive = true;
            this.dragState.pointerId = event.pointerId;
            this.dragState.startX = event.clientX;
            this.dragState.startY = event.clientY;
            this.dragState.activeIndex = activeIndex;
            this.dragState.source = slot.dataset.source || "grid";
            this.dragState.slotType = slotType;
            this.dragState.equippedIndex = Number.isFinite(equipIndex) ? equipIndex : null;
            this.dragState.originElement = slot;
            this.dragState.moved = false;
            this.dragState.completed = false;
            this.dragState.hoverElement = null;
            this.suppressInventoryClick = false;
            window.addEventListener("pointermove", handlePointerMove);
            window.addEventListener("pointerup", handlePointerUp);
            window.addEventListener("pointercancel", handlePointerCancel);
        };

        if (this.elements.inventoryGrid) {
            this.elements.inventoryGrid.addEventListener("click", inventoryClickHandler);
            this.elements.inventoryGrid.addEventListener("pointerdown", handlePointerDown);
        }
        if (this.elements.inventoryBar) {
            this.elements.inventoryBar.addEventListener("click", inventoryClickHandler);
            this.elements.inventoryBar.addEventListener("pointerdown", handlePointerDown);
        }
        if (this.elements.inventoryArmorSlot) {
            this.elements.inventoryArmorSlot.addEventListener("click", inventoryClickHandler);
            this.elements.inventoryArmorSlot.addEventListener("pointerdown", handlePointerDown);
        }

        const craftingContainer = this.elements.craftingOptions;
        if (craftingContainer) {
            craftingContainer.addEventListener("click", (event) => {
                const rawTarget = event.target;
                const elementTarget = rawTarget instanceof Element ? rawTarget : rawTarget?.parentElement;
                if (!elementTarget) {
                    return;
                }
                const button = elementTarget.closest("button[data-craft-key]");
                if (!button || !craftingContainer.contains(button)) {
                    return;
                }
                event.preventDefault();
                const isDisabled = button.classList.contains("disabled") || button.hasAttribute("disabled");
                if (isDisabled) {
                    const reason = button.dataset.disabledReason || "Not enough resources.";
                    this.showMessage(reason, 1.6, "#ff8888");
                    return;
                }
                const key = button.dataset.craftKey;
                if (key && this.onCraftRequest) {
                    this.onCraftRequest(key);
                }
            });
        }

    }

    updateResources(resources = {}) {
        const wood = resources.wood ?? 0;
        const stone = resources.stone ?? 0;
        const metal = resources.metal ?? 0;
        const berries = resources.berries ?? 0;
        if (this.elements.wood) {
            this.elements.wood.textContent = `Wood: ${wood}`;
        }
        if (this.elements.stone) {
            this.elements.stone.textContent = `Stone: ${stone}`;
        }
        if (this.elements.metal) {
            this.elements.metal.textContent = `Metal: ${metal}`;
        }
        if (this.elements.berries) {
            this.elements.berries.textContent = `Berries: ${berries}`;
        }
    }

    updateVitals(data = {}) {
        const playerHealth = Math.max(0, data.playerHealth ?? 0);
        const playerMax = Math.max(1, data.playerMaxHealth ?? 1);
        const houseHealth = Math.max(0, data.houseHealth ?? 0);
        const houseMax = Math.max(1, data.houseMaxHealth ?? 1);
        const playerRatio = Math.max(0, Math.min(1, playerHealth / playerMax));
        const houseRatio = Math.max(0, Math.min(1, houseHealth / houseMax));

        if (this.elements.playerHealthFill) {
            this.elements.playerHealthFill.style.width = `${(playerRatio * 100).toFixed(1)}%`;
        }
        if (this.elements.playerHealthValue) {
            this.elements.playerHealthValue.textContent = `${Math.round(playerHealth)} / ${Math.round(playerMax)}`;
        }
        if (this.elements.houseHealthFill) {
            this.elements.houseHealthFill.style.width = `${(houseRatio * 100).toFixed(1)}%`;
        }
        if (this.elements.houseHealthValue) {
            this.elements.houseHealthValue.textContent = `${Math.round(houseHealth)} / ${Math.round(houseMax)}`;
        }

        const playerVital = this.elements.playerVital;
        if (playerVital) {
            playerVital.classList.toggle("flash", (data.damageFlash ?? 0) > 0);
        }
    }

    updateHouse(house) {
        if (this.elements.houseHealthFill && this.elements.houseHealthValue) {
            const max = Math.max(1, house?.maxHp ?? 1);
            const hp = Math.max(0, house?.hp ?? 0);
            const ratio = Math.max(0, Math.min(1, hp / max));
            this.elements.houseHealthFill.style.width = `${(ratio * 100).toFixed(1)}%`;
            this.elements.houseHealthValue.textContent = `${Math.round(hp)} / ${Math.round(max)}`;
        } else if (this.elements.health) {
            this.elements.health.textContent = `House HP: ${Math.max(0, Math.round(house?.hp ?? 0))}`;
        }
    }

    updatePhase(dayNumber, phase, metric) {
        this.elements.day.textContent = `Day ${dayNumber}`;
        if (phase === "day") {
            this.elements.time.textContent = `Daytime - ${Math.max(0, Math.ceil(metric))}s left`;
        } else if (phase === "night") {
            this.elements.time.textContent = `Night - ${Math.max(0, Math.ceil(metric))} enemies remaining`;
        } else {
            this.elements.time.textContent = phase;
        }
    }

    showMessage(text, duration = 2, color = "#f0c674") {
        this.elements.message.textContent = text;
        this.elements.message.style.color = color;
        if (this.messageTimeout) {
            clearTimeout(this.messageTimeout);
        }
        this.messageTimeout = setTimeout(() => {
            this.elements.message.textContent = "";
        }, duration * 1000);
    }


    setInventoryData(resources = {}, items = [], capacity = 0, options = {}) {
        const gridElement = this.elements.inventoryGrid;
        const barElement = this.elements.inventoryBar;
        const armorElement = this.elements.inventoryArmorSlot;
        const opts = options ?? {};
        const selectedIndex = Number.isFinite(opts.selectedIndex) ? opts.selectedIndex : -1;
        const columns = Math.max(1, Number.isFinite(opts.columns) ? opts.columns : 8);
        const equippedMap = opts.equipped && typeof opts.equipped === "object" ? opts.equipped : {};
        const escapeHtml = (value = "") => String(value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
        const escapeAttr = (value = "") => escapeHtml(value).replace(/"/g, "&quot;");

        this.cachedInventoryResources = { ...resources };
        const list = Array.isArray(items) ? items.slice() : [];
        this.cachedInventoryItems = list.slice();

        const renderSlot = (slotIndex, source, slotOptions = {}) => {
            const {
                extraClasses = [],
                dataset = {},
                titleOverride = null,
                itemOverride = null,
                itemIndexOverride = null
            } = slotOptions;
            const hasValidIndex = Number.isInteger(slotIndex) && slotIndex >= 0;
            const resolvedItem = itemOverride ?? (hasValidIndex && slotIndex < list.length ? list[slotIndex] : null);
            const resolvedIndex = Number.isInteger(itemIndexOverride) ? itemIndexOverride : (hasValidIndex ? slotIndex : null);
            const slotIndexAttr = Number.isInteger(slotIndex) ? slotIndex : -1;
            const slotClasses = ["inventory-slot", ...extraClasses];
            const isSelected = Boolean(resolvedItem) && hasValidIndex && selectedIndex === slotIndex;
            const isHotbarSlot = hasValidIndex && slotIndex < columns;
            const attrParts = [
                `data-slot-index="${escapeAttr(String(slotIndexAttr))}"`,
                `data-source="${escapeAttr(source)}"`
            ];
            for (const [rawKey, value] of Object.entries(dataset)) {
                if (value === undefined || value === null) {
                    continue;
                }
                const safeKey = String(rawKey).toLowerCase().replace(/[^a-z0-9_-]/g, "");
                if (!safeKey) {
                    continue;
                }
                attrParts.push(`data-${safeKey}="${escapeAttr(String(value))}"`);
            }
            if (isHotbarSlot) {
                slotClasses.push("hotbar-slot");
                attrParts.push('data-hotbar="true"');
            }
            if (!resolvedItem) {
                slotClasses.push("empty");
                attrParts.push('tabindex="-1"', 'aria-disabled="true"');
                const titleAttr = escapeAttr("Empty slot");
                return `<button type="button" class="${slotClasses.join(" ")}" ${attrParts.join(" ")} title="${titleAttr}"></button>`;
            }
            if (isSelected) {
                slotClasses.push("selected");
                attrParts.push('data-selected="true"', 'aria-pressed="true"');
            }
            if (resolvedItem.equipped) {
                slotClasses.push("equipped");
            }
            const baseTitle = titleOverride ?? (resolvedItem.description || resolvedItem.name || "Item");
            const titleSuffix = titleOverride ? "" : (resolvedItem.equipped ? " (Equipped)" : "");
            const titleAttr = escapeAttr(`${baseTitle}${titleSuffix}`);
            const iconPath = resolveItemIconPath(resolvedItem);
            const iconContent = iconPath
                ? `<img class="inventory-icon" src="${iconPath}" alt="${titleAttr}">`
                : `<span class="inventory-fallback">${escapeHtml(resolvedItem.icon || (resolvedItem.name ? resolvedItem.name.charAt(0) : "?"))}</span>`;
            const countBadge = (resolvedItem.count ?? 0) > 1
                ? `<span class="inventory-slot-count">${escapeHtml(resolvedItem.count)}</span>`
                : "";
            const equippedBadge = resolvedItem.equipped ? '<span class="inventory-slot-badge">E</span>' : "";
            if (resolvedIndex !== null) {
                attrParts.push(`data-item-index="${escapeAttr(String(resolvedIndex))}"`);
            }
            return `<button type="button" class="${slotClasses.join(" ")}" ${attrParts.join(" ")} title="${titleAttr}">${iconContent}${countBadge}${equippedBadge}</button>`;
        };

        const renderEquipmentSlot = (slotType, label) => {
            const equippedIndex = list.findIndex((item) => item?.slot === slotType && item.equipped);
            const equippedItem = equippedMap && typeof equippedMap === "object" ? equippedMap[slotType] : null;
            const safeSlotType = escapeAttr(slotType || "unknown");
            if (equippedIndex !== -1) {
                return renderSlot(equippedIndex, "equipment", {
                    extraClasses: ["equipment-slot"],
                    dataset: { "slot-type": slotType }
                });
            }
            if (!equippedItem) {
                const fallbackLabel = (label || slotType || "?").charAt(0).toUpperCase();
                const titleAttr = escapeAttr(`No ${label || slotType} equipped`);
                return `<button type="button" class="inventory-slot equipment-slot empty" data-source="equipment" data-slot-type="${safeSlotType}" data-slot-index="-1" aria-disabled="true" tabindex="-1" title="${titleAttr}"><span class="inventory-fallback">${escapeHtml(fallbackLabel)}</span></button>`;
            }
            const overrideItem = { ...equippedItem };
            const itemIndexOverride = Number.isInteger(equippedItem.inventoryIndex) ? equippedItem.inventoryIndex : -1;
            const dataset = { "slot-type": slotType };
            if (Number.isInteger(equippedItem.inventoryIndex)) {
                dataset["equipped-index"] = equippedItem.inventoryIndex;
            }
            return renderSlot(-1, "equipment", {
                extraClasses: ["equipment-slot"],
                dataset,
                itemOverride: overrideItem,
                itemIndexOverride
            });
        };

        const totalSlotsRaw = Number.isFinite(capacity) && capacity > 0 ? capacity : list.length;
        const slotTotal = Math.max(totalSlotsRaw || 0, columns);
        const rows = Math.max(1, Math.ceil(slotTotal / columns));

        if (gridElement) {
            const gridMarkup = [];
            for (let row = 0; row < rows; row++) {
                for (let col = 0; col < columns; col++) {
                    const slotIndex = ((rows - 1 - row) * columns) + col;
                    if (slotIndex >= slotTotal) {
                        continue;
                    }
                    gridMarkup.push(renderSlot(slotIndex, "grid"));
                }
            }
            gridElement.style.setProperty("--inventory-grid-columns", String(columns));
            gridElement.innerHTML = gridMarkup.join("");
        }

        if (barElement) {
            const hotbarSlots = Math.min(columns, slotTotal);
            const barMarkup = [];
            for (let i = 0; i < hotbarSlots; i++) {
                barMarkup.push(renderSlot(i, "bar"));
            }
            barElement.innerHTML = barMarkup.join("");
        }

        if (armorElement) {
            armorElement.innerHTML = renderEquipmentSlot("armor", "Armor");
        }
    }

    updateBuildSelection(selectionKey, resources = {}, kitCounts = {}) {
        const element = this.elements.buildStatus;
        if (!element) {
            return;
        }

        if (!selectionKey) {
            element.textContent = DEFAULT_BUILD_MESSAGE;
            element.classList.remove("warning");
            return;
        }

        const blueprint = STRUCTURE_TYPES[selectionKey];
        if (!blueprint) {
            element.textContent = "Unknown structure";
            element.classList.add("warning");
            return;
        }

        const kitOwned = kitCounts[selectionKey] ?? 0;
        const costEntries = Object.entries(blueprint.cost || {}).filter(([, amount]) => amount > 0);
        const costMarkup = costEntries.length > 0
            ? costEntries.map(([resource, amount]) => {
                const available = resources[resource] ?? 0;
                const affordable = available >= amount;
                const className = affordable ? "cost" : "cost unaffordable";
                return `<span class="${className}">${formatResourceName(resource)} ${amount}</span>`;
            }).join(" ")
            : '<span class="cost">No materials</span>' ;

        const structureName = formatStructureName(selectionKey);
        element.innerHTML = `<strong>${structureName} Kit</strong> - Craft cost: ${costMarkup} &middot; Kits owned: ${kitOwned}`;
        const needsCrafting = kitOwned <= 0;
        element.classList.toggle("warning", needsCrafting);
        if (needsCrafting) {
            element.innerHTML += ' &middot; <span class="cost unaffordable">Craft at the table</span>';
        }
    }

    toggleInventory(show) {
        const panel = this.elements.inventoryPanel;
        const bar = this.elements.inventoryBarContainer;
        const wrapper = panel ? panel.closest(".wrapper") : null;
        if (!panel) {
            return;
        }
        if (show) {
            panel.classList.add("active");
            panel.setAttribute("aria-hidden", "false");
            if (bar) {
                bar.classList.add("hidden");
                bar.setAttribute("aria-hidden", "true");
            }
        } else {
            panel.classList.remove("active");
            panel.setAttribute("aria-hidden", "true");
            if (bar) {
                bar.classList.remove("hidden");
                bar.setAttribute("aria-hidden", "false");
            }
        }
        if (wrapper) {
            wrapper.classList.toggle("inventory-open", Boolean(show));
        }
    }

    bindCraftingHandler(handler) {
        this.onCraftRequest = handler;
    }

    bindInventoryItemHandler(handler) {
        this.onInventoryItemUse = handler;
    }

    bindInventoryReorderHandler(handler) {
        this.onInventoryReorder = handler;
    }

    showCraftingMenu(data) {
        this.renderCraftingOptions(data);
        if (this.elements.craftingPanel) {
            this.elements.craftingPanel.classList.add("active");
        }
    }

    hideCraftingMenu() {
        if (this.elements.craftingPanel) {
            this.elements.craftingPanel.classList.remove("active");
        }
    }

    updateCraftingMenu(data) {
        if (!this.elements.craftingPanel || !this.elements.craftingPanel.classList.contains("active")) {
            return;
        }
        this.renderCraftingOptions(data);
    }

    renderCraftingOptions(data = {}) {
        const { resources = {}, options = [] } = data;

        if (this.elements.craftingResources) {
            const summary = Object.entries(resources)
                .map(([key, value]) => `<span><strong>${formatResourceName(key)}:</strong> ${value}</span>`)
                .join("");
            this.elements.craftingResources.innerHTML = summary || "<span>No resources</span>";
        }

        if (!this.elements.craftingOptions) {
            return;
        }

        if (!options.length) {
            this.elements.craftingOptions.innerHTML = "<p>No recipes available.</p>";
            return;
        }

        const markup = options.map((option) => {
            const iconPath = option.iconPath || STRUCTURE_ICON_PATHS[option.key] || "";
            const iconMarkup = iconPath
                ? `<img src="${iconPath}" alt="${option.name} icon">`
                : `<div class="inventory-resource-icon-fallback">${(option.name || "?").charAt(0)}</div>`;
            const costEntries = option.costEntries || [];
            const costLine = costEntries.length
                ? costEntries.map((entry) => {
                    const className = entry.affordable ? "" : "unaffordable";
                    return `<span class="${className}">${formatResourceName(entry.resource)} ${entry.amount}</span>`;
                }).join(" ")
                : "<span>Free</span>";
            const disabledClass = option.canCraft ? "" : " disabled";
            const disabledAttr = option.canCraft ? "" : " disabled aria-disabled=\"true\"";
            const reasonAttr = option.disabledReason ? ` data-disabled-reason="${option.disabledReason}"` : "";
            const note = option.note ? `<div class="crafting-option-owned">${option.note}</div>` : "";
            return `
                <div class="crafting-option">
                    <div class="crafting-option-header">
                        ${iconMarkup}
                        <div>
                            <p class="crafting-option-title">${option.name}</p>
                            <div class="crafting-option-owned">Kits owned: ${option.owned ?? 0}</div>
                        </div>
                    </div>
                    <div class="crafting-cost-line">${costLine}</div>
                    ${note}
                    <button type="button" class="crafting-button${disabledClass}" data-craft-key="${option.key}"${reasonAttr}${disabledAttr}>Craft</button>
                </div>`;
        }).join("");
        this.elements.craftingOptions.innerHTML = markup;
    }
}
