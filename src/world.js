import { HOUSE_START_HP, WORLD_SETTINGS, MAP_WIDTH, MAP_HEIGHT, MAP_EXPANSION_WIDTH, MAP_EXPANSION_HEIGHT } from "./constants.js";
import { getAsset } from "./assets.js";
import { distance } from "./utils.js";

export class World {
    constructor() {
        this.baseWidth = MAP_WIDTH;
        this.baseHeight = MAP_HEIGHT;
        this.width = MAP_WIDTH;
        this.height = MAP_HEIGHT;
        this.expansionWidth = MAP_EXPANSION_WIDTH;
        this.expansionHeight = MAP_EXPANSION_HEIGHT;
        this.expansionCount = 0;

        this.house = {
            position: { ...WORLD_SETTINGS.housePosition },
            size: 80,
            hp: HOUSE_START_HP,
            maxHp: HOUSE_START_HP
        };
        const doorOffsetY = this.house.size * 0.46;
        this.house.door = {
            radius: Math.max(32, this.house.size * 0.55),
            outside: {
                position: {
                    x: this.house.position.x,
                    y: this.house.position.y + doorOffsetY
                }
            }
        };
    }

    getWidth() {
        return this.width;
    }

    getHeight() {
        return this.height;
    }

    getSize() {
        return { width: this.width, height: this.height };
    }

    getExpansionCount() {
        return this.expansionCount;
    }

    expand() {
        const widthIncrease = Math.max(0, this.expansionWidth);
        const heightIncrease = Math.max(0, this.expansionHeight);
        if (widthIncrease === 0 && heightIncrease === 0) {
            return false;
        }
        this.expansionCount += 1;
        this.width += widthIncrease;
        this.height += heightIncrease;
        return { width: this.width, height: this.height, expansionCount: this.expansionCount };
    }

    damageHouse(amount) {
        const damage = Math.max(0, amount);
        this.house.hp = Math.max(0, this.house.hp - damage);
        return this.house.hp <= 0;
    }

    resetHouse() {
        this.house.hp = this.house.maxHp;
    }

    getHouseDoorOutsidePosition() {
        return { ...this.house.door.outside.position };
    }

    isNearHouseDoor(point, radius = this.house.door.radius) {
        const doorPosition = this.house.door.outside.position;
        const threshold = radius ?? this.house.door.radius;
        return distance(point, doorPosition) <= threshold;
    }

    drawGround(ctx, phase, camera) {
        ctx.fillStyle = phase === "day" ? "#1d2c3b" : "#0b111b";
        ctx.fillRect(-camera.x, -camera.y, this.width, this.height);

        const gradient = ctx.createLinearGradient(
            -camera.x,
            -camera.y,
            this.width - camera.x,
            this.height - camera.y
        );
        gradient.addColorStop(0, phase === "day" ? "rgba(45, 64, 82, 0.4)" : "rgba(8, 12, 20, 0.45)");
        gradient.addColorStop(1, "rgba(12, 18, 28, 0.1)");
        ctx.fillStyle = gradient;
        ctx.fillRect(-camera.x, -camera.y, this.width, this.height);

        ctx.strokeStyle = "rgba(90, 120, 160, 0.35)";
        ctx.lineWidth = 4;
        ctx.strokeRect(-camera.x + 2, -camera.y + 2, this.width - 4, this.height - 4);
    }

    drawHouse(ctx, camera) {
        const { x, y } = this.house.position;
        const sprite = getAsset("house");
        if (sprite?.loaded) {
            const drawWidth = this.house.size * 2.4;
            const aspect = sprite.image.width / sprite.image.height;
            const drawHeight = drawWidth / aspect;
            ctx.drawImage(
                sprite.image,
                x - camera.x - drawWidth / 2,
                y - camera.y - drawHeight / 2,
                drawWidth,
                drawHeight
            );
        } else {
            const size = this.house.size;
            ctx.fillStyle = "#c3a87a";
            ctx.fillRect(x - size / 2 - camera.x, y - size / 2 - camera.y, size, size);
            ctx.fillStyle = "#2b1b0f";
            ctx.fillRect(x - size / 6 - camera.x, y - size / 2 - camera.y, size / 3, size / 2);
        }
    }
}

