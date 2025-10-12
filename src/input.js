const normalizeKey = (key) => (key.length === 1 ? key.toLowerCase() : key);

export function initializeInput(canvas) {
    const inputState = {
        up: false,
        down: false,
        left: false,
        right: false,
        sprint: false,
        interact: false,
        attack: false,
        upgrade: false,
        buildSelection: null,
        rotatePlacement: false,
        inventoryToggle: false,
        pauseToggle: false,
        consumeBerries: false,
        hotbarSelect: null,
        hotbarScroll: 0,
        cancelPlacement: false,
        mouse: {
            x: 0,
            y: 0,
            worldX: 0,
            worldY: 0,
            clicked: false
        }
    };

    const keyboardMovement = { up: false, down: false, left: false, right: false };
    const touchMovement = { up: false, down: false, left: false, right: false };
    let keyboardSprint = false;
    let touchSprint = false;

    const syncMovementState = () => {
        inputState.up = keyboardMovement.up || touchMovement.up;
        inputState.down = keyboardMovement.down || touchMovement.down;
        inputState.left = keyboardMovement.left || touchMovement.left;
        inputState.right = keyboardMovement.right || touchMovement.right;
        inputState.sprint = keyboardSprint || touchSprint;
    };

    inputState.setTouchMovement = (state = {}) => {
        touchMovement.up = Boolean(state.up);
        touchMovement.down = Boolean(state.down);
        touchMovement.left = Boolean(state.left);
        touchMovement.right = Boolean(state.right);
        syncMovementState();
    };

    inputState.clearTouchMovement = () => {
        touchMovement.up = false;
        touchMovement.down = false;
        touchMovement.left = false;
        touchMovement.right = false;
        syncMovementState();
    };

    inputState.setTouchSprint = (active) => {
        touchSprint = Boolean(active);
        syncMovementState();
    };

    inputState.resetTouchInput = () => {
        inputState.clearTouchMovement();
        touchSprint = false;
        syncMovementState();
    };

    const keyMap = {
        ArrowUp: "up",
        ArrowDown: "down",
        ArrowLeft: "left",
        ArrowRight: "right",
        w: "up",
        s: "down",
        a: "left",
        d: "right",
        e: "interact",
        E: "interact",
        f: "upgrade",
        F: "upgrade",
        " ": "attack",
        i: "inventory",
        I: "inventory",
        h: "consumeBerries",
        H: "consumeBerries",
        Shift: "sprint"
    };

    window.addEventListener("keydown", (event) => {
        if (event.repeat) return;

        if (event.key === "Escape") {
            inputState.pauseToggle = true;
            inputState.cancelPlacement = true;
            event.preventDefault();
            return;
        }

        if (event.key === "p" || event.key === "P") {
            inputState.pauseToggle = true;
            return;
        }

        const key = normalizeKey(event.key);
        const mapped = keyMap[key];
        if (mapped === "inventory") {
            inputState.inventoryToggle = true;
            return;
        }
        if (mapped) {
            if (mapped === "sprint") {
                keyboardSprint = true;
                syncMovementState();
            } else if (mapped in keyboardMovement) {
                keyboardMovement[mapped] = true;
                syncMovementState();
            } else {
                inputState[mapped] = true;
            }
        }
        if (/^[1-8]$/.test(key)) {
            inputState.hotbarSelect = Number.parseInt(key, 10) - 1;
            event.preventDefault();
            return;
        }
        if (key === "r") {
            inputState.rotatePlacement = true;
        }
    });

    window.addEventListener("keyup", (event) => {
        const key = normalizeKey(event.key);
        const mapped = keyMap[key];
        if (!mapped) {
            return;
        }
        if (mapped === "inventory") {
            return;
        }
        if (mapped === "sprint") {
            keyboardSprint = false;
            syncMovementState();
            return;
        }
        if (mapped in keyboardMovement) {
            keyboardMovement[mapped] = false;
            syncMovementState();
            return;
        }
        inputState[mapped] = false;
        if (key === "r") {
            inputState.rotatePlacement = false;
        }
    });

    const updatePointerPosition = (event) => {
        const rect = canvas.getBoundingClientRect();
        // Scale mouse coordinates to match canvas resolution when CSS resizes.
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        inputState.mouse.x = (event.clientX - rect.left) * scaleX;
        inputState.mouse.y = (event.clientY - rect.top) * scaleY;
        inputState.mouse.worldX = inputState.mouse.x;
        inputState.mouse.worldY = inputState.mouse.y;
    };

    canvas.addEventListener("mousemove", (event) => {
        updatePointerPosition(event);
    });

    canvas.addEventListener("mousedown", () => {
        inputState.mouse.clicked = true;
    });

    canvas.addEventListener("mouseup", () => {
        inputState.mouse.clicked = false;
    });

    const supportsPointerType = (event) => {
        if (typeof event.pointerType === "string") {
            return event.pointerType === "touch" || event.pointerType === "pen";
        }
        return false;
    };

    const handleTouchPointerDown = (event) => {
        if (!supportsPointerType(event)) {
            return;
        }
        event.preventDefault();
        updatePointerPosition(event);
        inputState.mouse.clicked = true;
    };

    const handleTouchPointerMove = (event) => {
        if (!supportsPointerType(event)) {
            return;
        }
        updatePointerPosition(event);
    };

    const handleTouchPointerEnd = (event) => {
        if (!supportsPointerType(event)) {
            return;
        }
        event.preventDefault();
        inputState.mouse.clicked = false;
    };

    canvas.addEventListener("pointerdown", handleTouchPointerDown, { passive: false });
    canvas.addEventListener("pointermove", handleTouchPointerMove);
    canvas.addEventListener("pointerup", handleTouchPointerEnd, { passive: false });
    canvas.addEventListener("pointercancel", handleTouchPointerEnd, { passive: false });

    canvas.addEventListener("wheel", (event) => {
        if (event.deltaY === 0) {
            return;
        }
        inputState.hotbarScroll = event.deltaY > 0 ? 1 : -1;
        event.preventDefault();
    }, { passive: false });

    return inputState;
}
