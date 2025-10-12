export function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

export function distance(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
}

export function lerp(a, b, t) {
    return a + (b - a) * t;
}

export function randomInCircle(radius) {
    const angle = Math.random() * Math.PI * 2;
    const r = radius * Math.sqrt(Math.random());
    return { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
}

export function rectanglesOverlap(a, b) {
    return !(
        a.x + a.width < b.x ||
        a.x > b.x + b.width ||
        a.y + a.height < b.y ||
        a.y > b.y + b.height
    );
}

export function pointInCircle(point, circle) {
    const dx = point.x - circle.x;
    const dy = point.y - circle.y;
    return dx * dx + dy * dy <= circle.radius * circle.radius;
}