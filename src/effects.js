import { random } from "./rng.js";

class FloatingText {
    constructor(text, position, color = "#7be0a6") {
        this.text = text;
        this.position = { ...position };
        this.color = color;
        this.lifetime = 1.2;
        this.elapsed = 0;
        this.velocity = { x: (random() - 0.5) * 20, y: -60 };
        this.alpha = 1;
    }

    update(delta) {
        this.elapsed += delta;
        this.position.x += this.velocity.x * delta;
        this.position.y += this.velocity.y * delta;
        this.alpha = Math.max(0, 1 - this.elapsed / this.lifetime);
        return this.elapsed < this.lifetime;
    }

    draw(ctx, camera) {
        ctx.save();
        ctx.globalAlpha = this.alpha;
        ctx.fillStyle = this.color;
        ctx.font = "18px Segoe UI";
        ctx.textAlign = "center";
        ctx.fillText(this.text, this.position.x - camera.x, this.position.y - camera.y);
        ctx.restore();
    }
}

class PulseCircle {
    constructor(position, startRadius, endRadius, color = "rgba(123, 224, 166, 0.4)") {
        this.position = { ...position };
        this.startRadius = startRadius;
        this.endRadius = endRadius;
        this.color = color;
        this.lifetime = 0.6;
        this.elapsed = 0;
    }

    update(delta) {
        this.elapsed += delta;
        return this.elapsed < this.lifetime;
    }

    draw(ctx, camera) {
        const t = Math.min(1, this.elapsed / this.lifetime);
        const radius = this.startRadius + (this.endRadius - this.startRadius) * t;
        const alpha = 1 - t;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = this.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(this.position.x - camera.x, this.position.y - camera.y, radius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
    }
}

class TurretProjectile {
    constructor({ from, to, color = "#f8f0d0", speed = 720, radius = 4 }) {
        this.start = { ...from };
        this.end = { ...to };
        this.color = color;
        this.speed = speed;
        this.radius = radius;
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        this.dx = dx;
        this.dy = dy;
        this.distance = Math.hypot(dx, dy);
        this.duration = this.distance > 0 ? this.distance / this.speed : 0;
        this.elapsed = 0;
        this.progress = 0;
    }

    update(delta) {
        this.elapsed += delta;
        if (this.duration <= 0) {
            this.progress = 1;
            return this.elapsed < 0.08;
        }
        this.progress = Math.min(1, this.elapsed / this.duration);
        return this.progress < 1;
    }

    draw(ctx, camera) {
        const t = this.progress;
        const px = this.start.x + this.dx * t;
        const py = this.start.y + this.dy * t;
        const tailT = Math.max(0, t - 0.18);
        const tailX = this.start.x + this.dx * tailT;
        const tailY = this.start.y + this.dy * tailT;

        ctx.save();
        ctx.lineCap = "round";
        ctx.strokeStyle = this.color;
        ctx.lineWidth = Math.max(1.5, this.radius * 0.85);
        ctx.globalAlpha = 0.7;
        ctx.beginPath();
        ctx.moveTo(px - camera.x, py - camera.y);
        ctx.lineTo(tailX - camera.x, tailY - camera.y);
        ctx.stroke();

        ctx.globalAlpha = 1;
        ctx.fillStyle = this.color;
        ctx.beginPath();
        ctx.arc(px - camera.x, py - camera.y, this.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }
}

export class EffectManager {
    constructor() {
        this.effects = [];
    }

    spawnFloatingText(options) {
        this.effects.push(new FloatingText(options.text, options.position, options.color));
    }

    spawnPulse(options) {
        this.effects.push(new PulseCircle(options.position, options.startRadius, options.endRadius, options.color));
    }

    spawnProjectile(options) {
        this.effects.push(new TurretProjectile(options));
    }

    update(delta) {
        this.effects = this.effects.filter((effect) => effect.update(delta));
    }

    draw(ctx, camera) {
        for (const effect of this.effects) {
            effect.draw(ctx, camera);
        }
    }

    clear() {
        this.effects.length = 0;
    }
}
