import { INVENTORY_ITEM_CAPACITY, RESOURCE_TYPES } from "./constants.js";
import { resolveItemIconPath, resolveItemWorldAsset, resolveItemWorldScale } from "./assets.js";

export const BERRY_STACK_KEY = "consumable:berries";

export class Inventory {
    constructor(initialResources = { wood: 24, stone: 16, metal: 10, berries: 0 }) {
        this.resources = { ...initialResources };
        this.capacity = INVENTORY_ITEM_CAPACITY;
        this.items = Array.from({ length: this.capacity }, () => null);
        this.equippedSlots = Object.create(null);
    }

    getStackKey(item) {
        if (!item || typeof item !== "object") {
            return null;
        }
        if (typeof item.stackKey === "string" && item.stackKey.length > 0) {
            return item.stackKey;
        }
        if (item.category === "structure-kit" && item.structureType) {
            return `structure-kit:${item.structureType}`;
        }
        if (item.stackable === true && item.name) {
            return `name:${item.name.toLowerCase()}`;
        }
        return null;
    }

    isStackable(item) {
        return Boolean(this.getStackKey(item));
    }

    addResource(type, amount) {
        if (!Object.prototype.hasOwnProperty.call(this.resources, type)) {
            this.resources[type] = 0;
        }
        this.resources[type] += amount;
        return this.resources[type];
    }

    canAfford(cost) {
        for (const [key, value] of Object.entries(cost)) {
            if ((this.resources[key] ?? 0) < value) {
                return false;
            }
        }
        return true;
    }

    spendResources(cost) {
        if (!this.canAfford(cost)) return false;
        for (const [key, value] of Object.entries(cost)) {
            this.resources[key] -= value;
        }
        return true;
    }

    refundResources(cost) {
        for (const [key, value] of Object.entries(cost)) {
            this.addResource(key, value);
        }
    }

    getResources() {
        const snapshot = { ...this.resources };
        snapshot.berries = this.countStack(BERRY_STACK_KEY);
        return snapshot;
    }

    addItem(item) {
        const stored = { ...item };
        const stackKey = this.getStackKey(stored);
        const incomingCount = Number.isFinite(stored.count) && stored.count > 0 ? stored.count : 1;
        stored.iconPath = resolveItemIconPath(stored);
        const worldAsset = resolveItemWorldAsset(stored);
        if (worldAsset) {
            stored.worldAssetKey = worldAsset;
        }
        const worldScale = resolveItemWorldScale(stored);
        if (worldScale) {
            stored.worldScale = worldScale;
        }

        if (stackKey) {
            const existingIndex = this.items.findIndex((slot) => slot && this.getStackKey(slot) === stackKey);
            if (existingIndex !== -1) {
                const existing = this.items[existingIndex];
                existing.iconPath = existing.iconPath ?? resolveItemIconPath(existing) ?? stored.iconPath ?? resolveItemIconPath(stored);
                if (!existing.worldAssetKey) {
                    const asset = resolveItemWorldAsset(existing) ?? worldAsset;
                    if (asset) { existing.worldAssetKey = asset; }
                }
                if (!existing.worldScale) {
                    const scale = resolveItemWorldScale(existing) ?? worldScale;
                    if (scale) { existing.worldScale = scale; }
                }
                existing.count = (existing.count ?? 1) + incomingCount;
                return existing;
            }
        }

        const emptyIndex = this.items.findIndex((slot) => !slot);
        if (emptyIndex === -1) {
            return false;
        }
        if (stackKey) {
            stored.count = incomingCount;
            stored.stackKey = stored.stackKey ?? stackKey;
            stored.stackable = true;
        } else if (!(Number.isFinite(stored.count) && stored.count > 1)) {
            delete stored.count;
        }
        this.items[emptyIndex] = stored;
        return stored;
    }

    canAddItem(item) {
        const stackKey = this.getStackKey(item);
        if (stackKey) {
            const existing = this.items.find((slot) => slot && this.getStackKey(slot) === stackKey);
            if (existing) {
                return true;
            }
        }
        return this.items.some((slot) => !slot);
    }

    hasFreeSlot(count = 1) {
        if (count <= 0) {
            return true;
        }
        let available = 0;
        for (const slot of this.items) {
            if (!slot) {
                available += 1;
                if (available >= count) {
                    return true;
                }
            }
        }
        return false;
    }

    hasStructureKit(type) {
        return this.items.some((item) => item?.category === "structure-kit" && item.structureType === type && (item.count ?? 1) > 0);
    }

    consumeStructureKit(type) {
        const index = this.items.findIndex((item) => item?.category === "structure-kit" && item.structureType === type);
        if (index === -1) {
            return null;
        }
        const kit = this.items[index];
        const currentCount = kit.count ?? 1;
        if (currentCount > 1) {
            kit.count = currentCount - 1;
            return { ...kit, count: 1 };
        }
        const removed = kit;
        this.items[index] = null;
        return removed;
    }

    countStructureKit(type) {
        return this.items.reduce((count, item) => {
            if (item?.category === "structure-kit" && item.structureType === type) {
                return count + (item.count ?? 1);
            }
            return count;
        }, 0);
    }

    getStructureKitCounts(structureKeys = ["barricade", "spike", "turret"]) {
        const counts = Object.create(null);
        for (const key of structureKeys) {
            counts[key] = counts[key] ?? 0;
        }
        for (const item of this.items) {
            if (item?.category === "structure-kit" && item.structureType) {
                const key = item.structureType;
                counts[key] = (counts[key] ?? 0) + (item.count ?? 1);
            }
        }
        return counts;
    }

    removeItem(predicate) {
        if (typeof predicate !== "function") {
            return null;
        }
        for (let index = 0; index < this.items.length; index += 1) {
            const item = this.items[index];
            if (!item) {
                continue;
            }
            if (!predicate(item, index)) {
                continue;
            }
            if (this.isStackable(item) && (item.count ?? 1) > 1) {
                item.count -= 1;
                return { ...item, count: 1 };
            }
            this.items[index] = null;
            return item;
        }
        return null;
    }

    getItems() {
        return this.items.map((item) => (item ? { ...item } : null));
    }

    getItemAt(index) {
        if (!Number.isInteger(index) || index < 0 || index >= this.items.length) {
            return null;
        }
        return this.items[index];
    }

    _restoreEquippedSlot(slotType, preferredIndex = null) {
        if (!this.equippedSlots || !this.equippedSlots[slotType]?.item) {
            if (this.equippedSlots) {
                this.equippedSlots[slotType] = null;
            }
            return null;
        }
        const entry = this.equippedSlots[slotType];
        const item = entry.item;
        delete item.equipped;
        const candidates = [];
        if (Number.isInteger(preferredIndex) && preferredIndex >= 0 && preferredIndex < this.items.length) {
            candidates.push(preferredIndex);
        }
        if (Number.isInteger(entry.storedIndex) && entry.storedIndex >= 0 && entry.storedIndex < this.items.length) {
            candidates.push(entry.storedIndex);
        }
        for (const candidate of candidates) {
            if (!Number.isInteger(candidate) || candidate < 0 || candidate >= this.items.length) {
                continue;
            }
            if (!this.items[candidate]) {
                this.items[candidate] = item;
                this.equippedSlots[slotType] = null;
                return { item, index: candidate };
            }
        }
        const emptyIndex = this.items.findIndex((slot) => !slot);
        if (emptyIndex !== -1) {
            this.items[emptyIndex] = item;
            this.equippedSlots[slotType] = null;
            return { item, index: emptyIndex };
        }
        item.equipped = true;
        this.equippedSlots[slotType] = entry;
        return null;
    }

    markEquippedSlot(slotType, index) {
        if (typeof slotType !== "string" || slotType.length === 0) {
            return;
        }
        if (slotType === "armor") {
            if (!this.equippedSlots) {
                this.equippedSlots = Object.create(null);
            }
            const targetIndex = Number.isInteger(index) && index >= 0 && index < this.items.length ? index : -1;
            if (targetIndex === -1) {
                this._restoreEquippedSlot(slotType);
                return;
            }
            const candidate = this.items[targetIndex];
            if (!candidate || candidate.slot !== slotType) {
                return;
            }
            const existing = this.equippedSlots[slotType];
            this.items[targetIndex] = null;
            if (existing?.item === candidate) {
                candidate.equipped = true;
                existing.storedIndex = targetIndex;
                this.equippedSlots[slotType] = existing;
                return;
            }
            this._restoreEquippedSlot(slotType);
            candidate.equipped = true;
            this.equippedSlots[slotType] = {
                item: candidate,
                storedIndex: targetIndex
            };
            return;
        }
        const targetIndex = Number.isInteger(index) && index >= 0 ? index : -1;
        for (let i = 0; i < this.items.length; i += 1) {
            const item = this.items[i];
            if (!item || item.slot !== slotType) {
                continue;
            }
            if (i === targetIndex) {
                item.equipped = true;
            } else if (item.equipped) {
                delete item.equipped;
            }
        }
    }

    clearEquippedSlot(slotType) {
        if (typeof slotType !== "string" || slotType.length === 0) {
            return;
        }
        if (slotType === "armor") {
            this._restoreEquippedSlot(slotType);
            return;
        }
        for (const item of this.items) {
            if (item?.slot === slotType && item.equipped) {
                delete item.equipped;
            }
        }
    }

    unequipToIndex(slotType, preferredIndex = null) {
        if (typeof slotType !== "string" || slotType.length === 0) {
            return null;
        }
        if (slotType === "armor") {
            return this._restoreEquippedSlot(slotType, preferredIndex);
        }
        return null;
    }

    getEquippedItem(slotType) {
        if (typeof slotType !== "string" || slotType.length === 0) {
            return null;
        }
        if (slotType === "armor") {
            const entry = this.equippedSlots?.[slotType];
            if (entry?.item) {
                const copy = { ...entry.item };
                if (Number.isInteger(entry.storedIndex)) {
                    copy.inventoryIndex = entry.storedIndex;
                }
                return copy;
            }
        }
        for (const item of this.items) {
            if (item?.slot === slotType && item.equipped) {
                return { ...item };
            }
        }
        return null;
    }

    countStack(stackKey) {
        if (!stackKey) {
            return 0;
        }
        return this.items.reduce((total, item) => {
            if (this.getStackKey(item) === stackKey) {
                return total + (item.count ?? 1);
            }
            return total;
        }, 0);
    }

    consumeStack(stackKey) {
        if (!stackKey) {
            return null;
        }
        return this.removeItem((item) => this.getStackKey(item) === stackKey);
    }

    getCapacity() {
        return this.capacity;
    }

    moveItem(fromIndex, toIndex) {
        if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)) {
            return -1;
        }
        if (fromIndex < 0 || fromIndex >= this.items.length) {
            return -1;
        }
        const item = this.items[fromIndex];
        if (!item) {
            return -1;
        }
        const maxIndex = this.items.length - 1;
        const target = Math.max(0, Math.min(toIndex, maxIndex));
        if (target === fromIndex) {
            return target;
        }
        const destination = this.items[target];
        this.items[target] = item;
        this.items[fromIndex] = destination ?? null;
        return target;
    }
}

export function resourceDisplayName(type) {
    return RESOURCE_TYPES[type]?.name ?? type;
}

export function createBerryItem(count = 1) {
    const safeCount = Number.isFinite(count) && count > 0 ? Math.floor(count) : 1;
    return {
        name: "Berries",
        category: "consumable",
        description: "Eat to restore a bit of health.",
        healAmount: 8,
        stackable: true,
        stackKey: BERRY_STACK_KEY,
        iconPath: "assets/props/berries.png",
        count: safeCount,
        useVerb: "Eat"
    };
}
