// Touch (left joystick + right-side drag to look) and keyboard/mouse input, merged into one state.

const JOY_RADIUS = 56; // px
const TOUCH_LOOK = 0.0055; // rad per px
const MOUSE_LOOK = 0.0024;

export class Input {
  /** Joystick or keys: x = strafe right, y = forward. Each in [-1, 1]. */
  moveX = 0;
  moveY = 0;
  sprint = false;
  enabled = true;
  /** Developer testing only (?debug&autowalk): hold "forward". */
  forceForward = false;
  private lookX = 0;
  private lookY = 0;
  private jumpQueued = false;
  private keys = new Set<string>();
  private joyId = -1;
  private joyOrigin = [0, 0];
  private joyVec = [0, 0];
  private lookId = -1;
  private lookLast = [0, 0];

  constructor(
    layer: HTMLElement,
    private canvas: HTMLCanvasElement,
    private joyBase: HTMLElement,
    private joyKnob: HTMLElement,
  ) {
    layer.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onUp);
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      this.keys.add(e.code);
      if (e.code === 'Space') this.jumpQueued = true;
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement === this.canvas && this.enabled) {
        this.lookX += e.movementX * MOUSE_LOOK;
        this.lookY += e.movementY * MOUSE_LOOK;
      }
    });
  }

  jump() { this.jumpQueued = true; }

  /** Returns and clears the look delta (radians) since the last call. */
  takeLook(): [number, number] {
    const r: [number, number] = [this.lookX, this.lookY];
    this.lookX = 0;
    this.lookY = 0;
    return r;
  }

  takeJump(): boolean {
    const j = this.jumpQueued;
    this.jumpQueued = false;
    return j;
  }

  /** Recomputes moveX / moveY from the joystick and keys. Call once per frame. */
  poll() {
    let kx = 0, ky = 0;
    const k = this.keys;
    if (k.has('KeyW') || k.has('ArrowUp')) ky += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) ky -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) kx += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) kx -= 1;
    const kl = Math.hypot(kx, ky);
    if (kl > 0) { kx /= kl; ky /= kl; }
    this.moveX = this.enabled ? kx + this.joyVec[0] : 0;
    this.moveY = this.enabled ? ky + this.joyVec[1] + (this.forceForward ? 1 : 0) : 0;
    const joyMag = Math.hypot(this.joyVec[0], this.joyVec[1]);
    this.sprint = k.has('ShiftLeft') || k.has('ShiftRight') || joyMag > 0.95;
  }

  reset() {
    this.joyId = -1;
    this.lookId = -1;
    this.joyVec = [0, 0];
    this.keys.clear();
    this.joyBase.style.display = 'none';
  }

  private onDown = (e: PointerEvent) => {
    if (!this.enabled) return;
    if (e.pointerType === 'mouse') {
      if (document.pointerLockElement !== this.canvas) {
        this.canvas.requestPointerLock?.();
        // Fallback when pointer lock is unavailable: drag to look.
        this.lookId = e.pointerId;
        this.lookLast = [e.clientX, e.clientY];
      }
      return;
    }
    e.preventDefault();
    const leftSide = e.clientX < window.innerWidth * 0.45;
    if (leftSide && this.joyId < 0) {
      this.joyId = e.pointerId;
      this.joyOrigin = [e.clientX, e.clientY];
      this.joyVec = [0, 0];
      this.joyBase.style.display = 'block';
      this.joyBase.style.left = `${e.clientX}px`;
      this.joyBase.style.top = `${e.clientY}px`;
      this.joyKnob.style.transform = 'translate(-50%, -50%)';
    } else if (this.lookId < 0) {
      this.lookId = e.pointerId;
      this.lookLast = [e.clientX, e.clientY];
    }
  };

  private onMove = (e: PointerEvent) => {
    if (e.pointerId === this.joyId) {
      let dx = e.clientX - this.joyOrigin[0];
      let dy = e.clientY - this.joyOrigin[1];
      const len = Math.hypot(dx, dy);
      if (len > JOY_RADIUS) { dx *= JOY_RADIUS / len; dy *= JOY_RADIUS / len; }
      this.joyVec = [dx / JOY_RADIUS, -dy / JOY_RADIUS];
      this.joyKnob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    } else if (e.pointerId === this.lookId) {
      const s = e.pointerType === 'mouse' ? MOUSE_LOOK : TOUCH_LOOK;
      this.lookX += (e.clientX - this.lookLast[0]) * s;
      this.lookY += (e.clientY - this.lookLast[1]) * s;
      this.lookLast = [e.clientX, e.clientY];
    }
  };

  private onUp = (e: PointerEvent) => {
    if (e.pointerId === this.joyId) {
      this.joyId = -1;
      this.joyVec = [0, 0];
      this.joyBase.style.display = 'none';
    }
    if (e.pointerId === this.lookId) this.lookId = -1;
  };
}
