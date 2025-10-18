import { PLAYER_SPEED, PLAYER_SPRINT_MULTIPLIER, PLAYER_MAX_HEALTH, PLAYER_MELEE_DAMAGE, PLAYER_MELEE_COOLDOWN } from "./constants.js";
import { clamp, distance } from "./utils.js";
import { getAsset, resolveItemWorldAsset, resolveItemWorldScale } from "./assets.js";

const PLAYER_MELEE_RANGE = 54;

export class Player {
    constructor(world, x, y, modifiers = {}) {
        this.world = world;
        this.position = { x, y };
        this.size = 28;
        this.baseSpeed = PLAYER_SPEED;
        this.sprintMultiplier = modifiers.sprintMultiplier ?? PLAYER_SPRINT_MULTIPLIER ?? 1.5;
        this.baseDamage = PLAYER_MELEE_DAMAGE * (modifiers.playerDamageMultiplier ?? 1);
        this.damageMultiplier = modifiers.playerDamageMultiplier ?? 1;
        this.weaponBonus = 0;
        this.armorReduction = modifiers.baseDamageReduction ?? 0;
        this.baseArmorReduction = this.armorReduction;
        this.maxHealth = Math.max(1, modifiers.playerHealth ?? PLAYER_MAX_HEALTH);
        this.health = this.maxHealth;
        this.meleeCooldown = 0;
        this.damageCooldown = 0.25;
        this.damageTimer = 0;
        this.baseGatherMultiplier = modifiers.gatherMultiplier ?? 1;
        this.armorOverlayKey = null;
        this.armorOverlayColor = "rgba(125, 224, 166, 0.75)";
        this.baseArmorOverlayColor = this.armorOverlayColor;
        this.equipment = {
            weapon: null,
            armor: null,
            tool: null
        };
        this.swingTimer = 0;
        this.swingDirection = 1;
        this.swingDuration = 0.24;
        this.activeSwingDuration = this.swingDuration;
        this.swingAnchor = null;
        this.swingStyle = "swing";
        this.lastAimAngle = 0;
        this.lastAimDirection = 1;
        this.applyDifficulty(modifiers);
    }

    applyDifficulty(modifiers = {}) {
        this.baseDamage = PLAYER_MELEE_DAMAGE * (modifiers.playerDamageMultiplier ?? 1);
        this.damageMultiplier = modifiers.playerDamageMultiplier ?? 1;
        const nextHealth = Math.max(1, modifiers.playerHealth ?? PLAYER_MAX_HEALTH);
        const preserveRatio = this.health / (this.maxHealth || 1);
        this.maxHealth = nextHealth;
        this.health = Math.min(nextHealth, Math.max(1, Math.round(nextHealth * preserveRatio)));
        if (modifiers.baseDamageReduction !== undefined) {
            this.armorReduction = modifiers.baseDamageReduction;
            this.baseArmorReduction = modifiers.baseDamageReduction;
        }
        if (modifiers.gatherMultiplier !== undefined) {
            this.baseGatherMultiplier = modifiers.gatherMultiplier;
        }
    }

    update(deltaSeconds, input) {
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

        const sprinting = input.sprint && length > 0;
        const speed = this.baseSpeed * (sprinting ? this.sprintMultiplier : 1);
        this.position.x += vx * speed * deltaSeconds;
        this.position.y += vy * speed * deltaSeconds;

        const maxX = this.world.getWidth() - this.size / 2;
        const maxY = this.world.getHeight() - this.size / 2;
        this.position.x = clamp(this.position.x, this.size / 2, maxX);
        this.position.y = clamp(this.position.y, this.size / 2, maxY);

        this.meleeCooldown = Math.max(0, this.meleeCooldown - deltaSeconds);
        this.damageTimer = Math.max(0, this.damageTimer - deltaSeconds);
        this.swingTimer = Math.max(0, this.swingTimer - deltaSeconds);
        if (this.swingTimer === 0) {
            this.swingAnchor = null;
            this.activeSwingDuration = this.swingDuration;
            this.swingStyle = "swing";
        }
    }

    canAttack() {
        return this.meleeCooldown <= 0;
    }

    getAttackDamage() {
        return Math.round((this.baseDamage + this.weaponBonus) * this.damageMultiplier);
    }

    getGatherMultiplier() {
        const toolBonus = this.equipment.tool?.gatherBonus ?? 1;
        return Math.max(0.1, this.baseGatherMultiplier * toolBonus);
    }

    startSwing(options = {}) {
        const {
            duration = this.swingDuration,
            direction = null,
            anchor = null,
            style = null
        } = options;
        const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : this.swingDuration;
        this.activeSwingDuration = safeDuration;
        this.swingTimer = safeDuration;
        this.swingStyle = typeof style === "string" ? style : "swing";

        if (anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.y)) {
            this.swingAnchor = { x: anchor.x, y: anchor.y };
            const dx = anchor.x - this.position.x;
            const dy = anchor.y - this.position.y;
            if (dx !== 0 || dy !== 0) {
                const aimAngle = Math.atan2(dy, dx);
                this.lastAimAngle = aimAngle;
                const aimDirection = dx >= 0 ? 1 : -1;
                if (aimDirection !== 0) {
                    this.lastAimDirection = aimDirection;
                }
            }
        } else {
            this.swingAnchor = null;
        }

        if (Number.isFinite(direction) && direction !== 0) {
            this.swingDirection = direction > 0 ? 1 : -1;
        } else {
            this.swingDirection = this.lastAimDirection || this.swingDirection || 1;
        }
    }

    performAttack(enemies) {
        if (!this.canAttack()) return [];
        const range = PLAYER_MELEE_RANGE;
        const hits = [];
        const damage = this.getAttackDamage();
        for (const enemy of enemies) {
            if (!enemy || !enemy.alive) continue;
            if (distance(this.position, enemy.position) <= range) {
                let killed = false;
                let applied = damage;
                try {
                    if (typeof enemy.takeDamage === 'function') {
                        killed = enemy.takeDamage(damage);
                        applied = damage;
                    } else if (typeof enemy.health === 'number') {
                        const prev = enemy.health;
                        enemy.health = Math.max(0, enemy.health - damage);
                        applied = prev - enemy.health;
                        if (enemy.health <= 0) {
                            enemy.alive = false;
                            killed = true;
                        }
                    } else {
                        // unknown enemy shape - mark as hit but do not attempt damage
                        applied = 0;
                    }
                } catch (err) {
                    console.error('Error applying damage to enemy', err);
                }
                hits.push({ enemy, killed, damage: applied });
            }
        }
        this.applyAttackAnimation(hits.length);
        return hits;
    }

    collectAttackTargets(enemies) {
        if (!Array.isArray(enemies) || enemies.length === 0) {
            return [];
        }
        const targets = [];
        for (const enemy of enemies) {
            if (!enemy || enemy.alive === false) continue;
            try {
                if (distance(this.position, enemy.position) <= PLAYER_MELEE_RANGE) {
                    targets.push(enemy);
                }
            } catch {
                // ignore malformed enemy data during target evaluation
            }
        }
        return targets;
    }

    applyAttackAnimation(hitCount = 0) {
        if (hitCount > 0) {
            this.meleeCooldown = PLAYER_MELEE_COOLDOWN;
        }
        const weaponName = this.equipment.weapon?.name?.toLowerCase() ?? "";
        const jabWeapon = weaponName.includes("spear") || weaponName.includes("blade");
        const jabDuration = jabWeapon ? this.swingDuration * (weaponName.includes("spear") ? 0.88 : 0.78) : undefined;
        this.startSwing({
            duration: jabDuration,
            style: jabWeapon ? "jab" : undefined
        });
    }

    takeDamage(amount) {
        const mitigation = clamp(this.armorReduction, 0, 0.85);
        const effective = Math.max(1, amount * (1 - mitigation));
        if (this.damageTimer > 0) {
            return { applied: 0, remaining: this.health, killed: false };
        }
        this.damageTimer = this.damageCooldown;
        this.health = Math.max(0, this.health - effective);
        return {
            applied: effective,
            remaining: this.health,
            killed: this.health <= 0
        };
    }

    heal(amount) {
        const healed = Math.max(0, Math.min(this.maxHealth, this.health + amount) - this.health);
        this.health += healed;
        return healed;
    }

    applyEquipment(item, options = {}) {
        if (!item || item.category !== 'equipment' || !item.slot) {
            return null;
        }
        const force = Boolean(options?.force);
        if (item.slot === 'weapon') {
            const nextBonus = Math.max(0, item.attackBonus ?? 0);
            const currentBonus = this.equipment.weapon?.attackBonus ?? 0;
            if (force || !this.equipment.weapon || nextBonus > currentBonus) {
                this.weaponBonus = nextBonus;
                this.equipment.weapon = {
                    name: item.name,
                    attackBonus: nextBonus,
                    rarity: item.rarity ?? 1,
                    worldAssetKey: resolveItemWorldAsset(item),
                    worldScale: resolveItemWorldScale(item)
                };
                return { slot: 'weapon', equipped: true };
            }
            return { slot: 'weapon', equipped: false };
        }
        if (item.slot === 'armor') {
            const baseReduction = Math.max(0, this.baseArmorReduction ?? 0);
            const nextReduction = Math.max(0, item.damageReduction ?? 0);
            const currentReduction = this.equipment.armor?.damageReduction ?? 0;
            if (force || !this.equipment.armor || nextReduction > currentReduction) {
                this.armorReduction = Math.max(baseReduction, nextReduction);
                this.equipment.armor = {
                    name: item.name,
                    damageReduction: nextReduction,
                    rarity: item.rarity ?? 1,
                    overlayKey: item.overlayKey ?? null,
                    overlayColor: item.overlayColor ?? this.armorOverlayColor
                };
                this.armorOverlayKey = this.equipment.armor.overlayKey ?? null;
                this.armorOverlayColor = this.equipment.armor.overlayColor ?? this.armorOverlayColor;
                return { slot: 'armor', equipped: true };
            }
            return { slot: 'armor', equipped: false };
        }
        if (item.slot === 'tool') {
            const gatherBonus = Math.max(1, item.gatherBonus ?? 1);
            const currentBonus = this.equipment.tool?.gatherBonus ?? 1;
            if (force || !this.equipment.tool || gatherBonus > currentBonus) {
                this.equipment.tool = {
                    name: item.name,
                    gatherBonus,
                    rarity: item.rarity ?? 1,
                    worldAssetKey: resolveItemWorldAsset(item),
                    worldScale: resolveItemWorldScale(item)
                };
                return { slot: 'tool', equipped: true };
            }
            return { slot: 'tool', equipped: false };
        }
        return null;
    }

    clearEquipmentSlot(slot) {
        if (!slot) {
            return;
        }
        if (slot === 'weapon') {
            this.equipment.weapon = null;
            this.weaponBonus = 0;
            return;
        }
        if (slot === 'armor') {
            this.equipment.armor = null;
            this.armorReduction = Math.max(0, this.baseArmorReduction ?? 0);
            this.armorOverlayKey = null;
            this.armorOverlayColor = this.baseArmorOverlayColor ?? "rgba(125, 224, 166, 0.75)";
            return;
        }
        if (slot === 'tool') {
            this.equipment.tool = null;
        }
    }

    isAlive() {
        return this.health > 0;
    }

    draw(ctx, camera, pointer) {
        const asset = getAsset("player");
        const drawX = this.position.x - camera.x;
        const drawY = this.position.y - camera.y;
        let width;
        let height;
        if (asset?.loaded) {
            const drawSize = 42;
            const aspect = asset.image.width / asset.image.height;
            width = drawSize;
            height = width / aspect;
        } else {
            width = this.size;
            height = this.size;
        }

        this.drawHeldItem(ctx, drawX, drawY, width, height, pointer);

        if (asset?.loaded) {
            ctx.drawImage(asset.image, drawX - width / 2, drawY - height / 2, width, height);
        } else {
            ctx.fillStyle = "#5bc0de";
            ctx.beginPath();
            ctx.arc(drawX, drawY, this.size / 2, 0, Math.PI * 2);
            ctx.fill();
        }

        this.drawArmorOverlay(ctx, drawX, drawY, width, height);
    }

    drawArmorOverlay(ctx, drawX, drawY, width, height) {
        if (!this.armorOverlayKey && !this.equipment.armor) {
            return;
        }
        const overlayAsset = this.armorOverlayKey ? getAsset(this.armorOverlayKey) : null;
        const overlayScale = 4 / 3;
        const verticalOffset = height * 0.3;
        if (overlayAsset?.loaded) {
            const overlayWidth = width * overlayScale;
            const overlayHeight = overlayWidth * (overlayAsset.image.height / overlayAsset.image.width);
            ctx.drawImage(
                overlayAsset.image,
                drawX - overlayWidth / 2,
                drawY - overlayHeight / 2 + verticalOffset,
                overlayWidth,
                overlayHeight
            );
            return;
        }

        const color = this.equipment.armor?.overlayColor ?? this.armorOverlayColor;
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(drawX, drawY + verticalOffset, width * 0.6 * overlayScale, Math.PI, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
        ctx.globalCompositeOperation = previousComposite;
    }

    drawHeldItem(ctx, drawX, drawY, width, height, pointer) {
        const held = this.equipment.tool || this.equipment.weapon;
        if (!held) {
            return;
        }
        let aimX = Number.isFinite(pointer?.x) ? pointer.x : this.position.x + 1;
        let aimY = Number.isFinite(pointer?.y) ? pointer.y : this.position.y;
        if (this.swingTimer > 0 && this.swingAnchor) {
            aimX = this.swingAnchor.x;
            aimY = this.swingAnchor.y;
        }
        const dx = aimX - this.position.x;
        const dy = aimY - this.position.y;
        const baseAngle = Math.atan2(dy, dx);
        const aimDirection = dx >= 0 ? 1 : -1;

        this.lastAimAngle = baseAngle;
        if (aimDirection !== 0) {
            this.lastAimDirection = aimDirection;
        }

        const swingStyle = this.swingTimer > 0 ? this.swingStyle : "swing";
        const isTool = held === this.equipment.tool;
        const assetKey = resolveItemWorldAsset(held);
        const identifier = (held.name ?? assetKey ?? "").toLowerCase();
        const heavyKeywords = ["axe", "hatchet", "pickaxe", "spear"];
        const isJab = swingStyle === "jab";
        const isHeavySwing = !isJab && (isTool || heavyKeywords.some((keyword) => identifier.includes(keyword)));

        const sizeReference = Math.max(width, height);
        const baseHandleOffset = sizeReference * 0.1;
        const baseReach = sizeReference * (isTool ? 1.06 : 0.94);
        const baseShaftOffset = sizeReference * 0.06;

        let angle = baseAngle;
        let handleOffset = baseHandleOffset;
        let reach = baseReach;
        let shaftOffset = baseShaftOffset;
        let spinOffset = 0;

        if (this.swingTimer > 0) {
            const swingDuration = Math.max(0.0001, this.activeSwingDuration || this.swingDuration);
            const progress = 1 - (this.swingTimer / swingDuration);
            const clampedProgress = progress < 0 ? 0 : progress > 1 ? 1 : progress;
            const eased = clampedProgress < 0.5
                ? 2 * clampedProgress * clampedProgress
                : 1 - Math.pow(-2 * clampedProgress + 2, 2) / 2;
            if (isJab) {
                const windup = 1 - eased;
                const extension = eased;
                const jabReachBoost = identifier.includes("spear") ? 0.6 : 0.38;
                angle = baseAngle
                    - this.swingDirection * 0.45 * windup
                    + this.swingDirection * 0.16 * extension;
                reach = baseReach * (1 - 0.18 * windup + jabReachBoost * extension);
                handleOffset = Math.max(baseHandleOffset * 0.5, baseHandleOffset * (0.75 - 0.25 * windup));
                shaftOffset = Math.max(baseShaftOffset * 0.45, baseShaftOffset * (0.85 - 0.35 * windup));
                spinOffset = this.swingDirection * 0.3 * extension;
            } else if (isHeavySwing) {
                // Heavy tools sweep through a wide arc with a bit of follow-through.
                const backSwing = isTool ? 1.05 : 0.78;
                const followThrough = isTool ? -0.42 : -0.28;
                const arcOffset = this.swingDirection * (backSwing + (followThrough - backSwing) * eased);
                const travel = Math.sin(eased * Math.PI);
                angle = baseAngle + arcOffset;
                reach = baseReach * (1 + travel * (isTool ? 0.24 : 0.18));
                handleOffset = baseHandleOffset * (1 + travel * 0.1);
                shaftOffset = baseShaftOffset * (1 + travel * 0.16);
                spinOffset = this.swingDirection * travel * (isTool ? 0.42 : 0.3);
            } else {
                // Light weapons still get a quick snap to avoid looking static.
                const snapBack = 0.32;
                const snapFollow = -0.18;
                const snapOffset = this.swingDirection * (snapBack + (snapFollow - snapBack) * eased);
                angle = baseAngle + snapOffset;
                spinOffset = this.swingDirection * 0.18 * Math.sin(eased * Math.PI);
            }
        }

        const handleX = drawX + Math.cos(angle) * handleOffset;
        const handleY = drawY + Math.sin(angle) * handleOffset;
        const shaftEndX = drawX + Math.cos(angle) * (handleOffset + shaftOffset);
        const shaftEndY = drawY + Math.sin(angle) * (handleOffset + shaftOffset);
        const spriteX = drawX + Math.cos(angle) * reach;
        const spriteY = drawY + Math.sin(angle) * reach;

        ctx.save();
        ctx.strokeStyle = isTool ? "rgba(255, 214, 102, 0.55)" : "rgba(255, 255, 255, 0.45)";
        ctx.lineWidth = 2;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(handleX, handleY);
        ctx.lineTo(shaftEndX, shaftEndY);
        ctx.stroke();
        ctx.restore();

        const asset = assetKey ? getAsset(assetKey) : null;
        ctx.save();
        ctx.translate(spriteX, spriteY);
        ctx.rotate(angle + Math.PI / 2 + spinOffset);
        const drawWidth = (resolveItemWorldScale(held) ?? 32) * 1.25;
        const drawHeight = drawWidth * (asset?.image.height ?? drawWidth) / (asset?.image.width ?? drawWidth);
        const offsetY = drawHeight * 0.55;
        if (asset?.loaded) {
            ctx.drawImage(asset.image, -drawWidth / 2, -offsetY, drawWidth, drawHeight);
        } else {
            const length = isTool ? 32 : 26;
            ctx.strokeStyle = isTool ? "#ffd166" : "#f4f4f4";
            ctx.lineWidth = isTool ? 5 : 4;
            ctx.beginPath();
            ctx.moveTo(-length * 0.5, 0);
            ctx.lineTo(length * 0.5, 0);
            ctx.stroke();
        }
        ctx.restore();
    }
}
