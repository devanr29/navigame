// First-person walker on the voxel heightmap. Units are blocks (1 block = 2.5 m).
import type * as THREE from 'three';
import { BLOCK_M, type WorldData } from '../gen/constants';
import type { Input } from './input';

const EYE = 1.7 / BLOCK_M; // eye height: 1.7 m
const WALK = 4.5 / BLOCK_M; // 4.5 m/s
const RUN = 8 / BLOCK_M; // 8 m/s
const STEP = 1.05; // climbs one block automatically
const GRAVITY = 22;
const JUMP_V = 7;
const RADIUS = 0.2;
const SWIM_DEPTH = 0.55; // how far the feet sit below the water surface when swimming

export class Player {
  x: number;
  z: number;
  footY: number;
  yaw = 0;
  pitch = 0;
  /** True while the compass is raised: the player stands still to sight. */
  frozen = false;
  /** Multiplies look speed (smaller while zoomed in through the compass sight). */
  lookScale = 1;
  /** Speed multiplier at a point (undergrowth slows walking). */
  slowAt: (x: number, z: number) => number = () => 1;
  /** Movement during the last update: horizontal blocks and blocks climbed (for the pace counter). */
  moved = 0;
  rose = 0;
  sprinting = false;
  /** When true, the team (navtup) moves the player along the cut path; walking input is ignored. */
  carried = false;
  private vy = 0;
  private onGround = true;
  private camY: number;

  constructor(private w: WorldData, spawn: [number, number], faceToward: [number, number]) {
    this.x = spawn[0];
    this.z = spawn[1];
    this.footY = this.standHeight(this.x, this.z);
    this.camY = this.footY;
    this.yaw = Math.atan2(-(faceToward[0] - this.x), -(faceToward[1] - this.z));
  }

  /** Walkable height at a point: column top, bridge deck, or swimming level. Infinity if blocked. */
  ground(x: number, z: number): number {
    const N = this.w.size;
    const xi = Math.floor(x), zi = Math.floor(z);
    if (xi < 0 || zi < 0 || xi >= N || zi >= N) return Infinity;
    const i = zi * N + xi;
    if (this.w.solid[i]) return Infinity;
    let g = this.w.height[i];
    const d = this.w.deck[i];
    if (d >= 0) g = Math.max(g, d);
    const wl = this.w.water[i];
    if (wl >= 0 && d < 0) g = Math.max(g, wl - SWIM_DEPTH);
    return g;
  }

  /**
   * Highest walkable ground under the player's footprint. Using the footprint (not just the centre)
   * lifts the player onto a step as soon as a foot reaches it, so the camera never dips inside a block.
   */
  standHeight(x: number, z: number): number {
    let g = -Infinity;
    for (const ox of [-RADIUS, RADIUS]) {
      for (const oz of [-RADIUS, RADIUS]) {
        const h = this.ground(x + ox, z + oz);
        if (h !== Infinity && h > g) g = h;
      }
    }
    return g === -Infinity ? this.ground(x, z) : g;
  }

  inWater(): boolean {
    const N = this.w.size;
    const i = Math.floor(this.z) * N + Math.floor(this.x);
    return this.w.water[i] >= 0 && this.w.deck[i] < 0;
  }

  /** Puts the player at a point (mission start), facing a grid azimuth in degrees. */
  teleport(x: number, z: number, faceAz: number) {
    this.x = x;
    this.z = z;
    this.footY = this.standHeight(x, z);
    this.camY = this.footY;
    this.vy = 0;
    this.yaw = (-faceAz * Math.PI) / 180;
    this.pitch = 0;
  }

  /** Moves the player directly (team mode). Tree trunks along the cut line do not block. */
  carryTo(x: number, z: number) {
    const N = this.w.size;
    const i = Math.floor(z) * N + Math.floor(x);
    const prevY = this.footY;
    this.moved += Math.hypot(x - this.x, z - this.z);
    this.x = x;
    this.z = z;
    const g = this.standHeight(x, z);
    this.footY = Number.isFinite(g) ? g : this.w.height[i];
    this.rose += this.footY - prevY;
  }

  update(dt: number, input: Input) {
    const x0 = this.x, z0 = this.z, y0 = this.footY;
    if (!this.carried) { this.moved = 0; this.rose = 0; }
    const [lx, ly] = input.takeLook();
    this.yaw -= lx * this.lookScale;
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch - ly * this.lookScale));

    const still = this.frozen || this.carried;
    let mx = still ? 0 : input.moveX, my = still ? 0 : input.moveY;
    const len = Math.hypot(mx, my);
    if (len > 1) { mx /= len; my /= len; }
    let speed = input.sprint ? RUN : WALK;
    if (this.inWater()) speed *= 0.5;
    speed *= this.slowAt(this.x, this.z);
    this.sprinting = input.sprint && len > 0.1;
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const vx = (-sin * my + cos * mx) * speed;
    const vz = (-cos * my - sin * mx) * speed;

    if (vx !== 0) this.tryMove(this.x + vx * dt, this.z);
    if (vz !== 0) this.tryMove(this.x, this.z + vz * dt);

    if (input.takeJump() && this.onGround && !still) {
      this.vy = JUMP_V;
      this.onGround = false;
    }
    const g = this.standHeight(this.x, this.z);
    if (this.vy > 0 || this.footY > g + 0.001) {
      this.vy -= GRAVITY * dt;
      this.footY += this.vy * dt;
      if (this.footY <= g) {
        this.footY = g;
        this.vy = 0;
        this.onGround = true;
      } else {
        this.onGround = false;
      }
    } else {
      this.footY = g; // step up (or stay)
      this.vy = 0;
      this.onGround = true;
    }

    // Smooth the camera when stepping up a block, so a 2.5 m step is not a jarring jump.
    if (this.footY > this.camY) this.camY += (this.footY - this.camY) * Math.min(1, dt * 10);
    else this.camY = this.footY;
    if (!this.carried) {
      this.moved = Math.hypot(this.x - x0, this.z - z0);
      this.rose = this.footY - y0;
    }
  }

  /** Clears the movement accumulated by carryTo (call once per frame after reading it). */
  consumeMove() {
    this.moved = 0;
    this.rose = 0;
  }

  applyCamera(cam: THREE.PerspectiveCamera) {
    cam.position.set(this.x, this.camY + EYE, this.z);
    cam.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }

  private tryMove(nx: number, nz: number) {
    const N = this.w.size;
    if (nx < 1 || nz < 1 || nx > N - 1 || nz > N - 1) return;
    const limit = this.footY + STEP;
    for (const ox of [-RADIUS, RADIUS]) {
      for (const oz of [-RADIUS, RADIUS]) {
        if (this.ground(nx + ox, nz + oz) > limit) return;
      }
    }
    this.x = nx;
    this.z = nz;
  }
}
