// Deterministic pseudo-random number generator utilities (Mulberry32).
// Allows synchronising random-dependent systems across clients by reusing the same seed.

let _seed = 1 >>> 0;
let _state = _seed;

function mulberry32(a) {
    return function () {
        let t = a += 0x6D2B79F5;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function refreshGenerator(newSeed) {
    _seed = newSeed >>> 0;
    _state = _seed;
    _rng = mulberry32(_state);
}

let _rng = mulberry32(_state);

export function setRandomSeed(seed) {
    refreshGenerator(seed >>> 0);
}

export function getRandomSeed() {
    return _seed >>> 0;
}

export function getRandomState() {
    return _state >>> 0;
}

export function setRandomState(state) {
    refreshGenerator(state >>> 0);
}

export function random() {
    const value = _rng();
    // Advance state roughly in sync with the generator by storing the latest truncated state.
    _state = (_state + 0x6D2B79F5) >>> 0;
    return value;
}

export function randomInt(minInclusive, maxExclusive) {
    if (!Number.isFinite(minInclusive) || !Number.isFinite(maxExclusive) || maxExclusive <= minInclusive) {
        throw new Error("randomInt requires numeric range with max > min");
    }
    return Math.floor(random() * (maxExclusive - minInclusive) + minInclusive);
}

export function randomFloat(minInclusive, maxExclusive) {
    return random() * (maxExclusive - minInclusive) + minInclusive;
}

export function randomChoice(collection) {
    if (!Array.isArray(collection) || collection.length === 0) {
        return undefined;
    }
    const index = Math.floor(random() * collection.length);
    return collection[index];
}

export function randomId(prefix = "id") {
    const body = Math.floor(random() * 1e9).toString(36);
    return `${prefix}-${body}`;
}

export function deriveSeedFromString(input = "") {
    let hash = 0;
    const str = String(input);
    for (let i = 0; i < str.length; i += 1) {
        hash = Math.imul(31, hash) + str.charCodeAt(i);
        hash |= 0;
    }
    return (hash >>> 0) || 1;
}

export function ensureSeed(seed) {
    if (seed === undefined || seed === null) {
        return Math.floor(Math.random() * 0xffffffff) >>> 0;
    }
    if (typeof seed === "string") {
        return deriveSeedFromString(seed);
    }
    const numeric = Number(seed);
    if (!Number.isFinite(numeric)) {
        return Math.floor(Math.random() * 0xffffffff) >>> 0;
    }
    return numeric >>> 0;
}

