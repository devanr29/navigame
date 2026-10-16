// Line of sight for compass sighting. A target can only be sighted if a straight line from the eye
// reaches it without passing through terrain, tree canopies or undergrowth, and within view distance.
import { DECLINATION_DEG, type Landmark, type WorldData } from '../gen/constants';

const DEG = 180 / Math.PI;

let declination = DECLINATION_DEG;

/** Sets the magnetic declination for the current level (degrees, east positive). */
export function setDeclination(deg: number) {
  declination = deg;
}

export function getDeclination() {
  return declination;
}

/** Grid azimuth (degrees clockwise from map north) from one point to another. x = east, z = south. */
export function azimuthTo(fromX: number, fromZ: number, toX: number, toZ: number): number {
  return norm360(Math.atan2(toX - fromX, -(toZ - fromZ)) * DEG);
}

/** Grid azimuth the player faces. yaw 0 = north, turning right makes yaw more negative. */
export function azimuthOfYaw(yaw: number): number {
  return norm360(-yaw * DEG);
}

/** What the compass shows: magnetic azimuth = grid azimuth − declination (east declination positive). */
export function magneticOf(gridAz: number): number {
  return norm360(gridAz - declination);
}

/** Grid azimuth from a magnetic one: grid = magnetic + declination. */
export function gridOf(magAz: number): number {
  return norm360(magAz + declination);
}

export function norm360(a: number): number {
  return ((a % 360) + 360) % 360;
}

/** Smallest signed difference a − b in degrees, in (−180, 180]. */
export function angleDiff(a: number, b: number): number {
  let d = norm360(a - b);
  if (d > 180) d -= 360;
  return d;
}

/** Back azimuth by the rule in the material: under 180° add 180°, over 180° subtract 180°, 180° gives 0°. */
export function backAzimuth(az: number): number {
  if (az < 180) return az + 180;
  if (az > 180) return az - 180;
  return 0;
}

/** Something that can be sighted: points that count as "seeing" it and its size for aiming. */
export interface SightTarget {
  id: number;
  x: number;
  y: number;
  z: number;
  pts: [number, number, number][];
  halfWidth: number;
  bottom: number;
  top: number;
}

export function landmarkTarget(l: Landmark, id: number): SightTarget {
  const base = { id, x: l.x, y: l.y, z: l.z };
  switch (l.kind) {
    case 'peak':
      return { ...base, pts: [[0, 0.3, 0], [0.4, 3.0, 0.28]], halfWidth: 1.5, bottom: -1, top: 3.2 };
    case 'tower':
      return { ...base, pts: [[0, 2, 0], [0, 8, 0], [0, 14, 0], [0, 20, 0], [0, 26, 0]], halfWidth: 1.5, bottom: 0, top: 27 };
    case 'hut':
      return {
        ...base, pts: [[0, 0.6, 2.1], [0, 1.9, 0], [2.1, 0.6, 0], [-2.1, 0.6, 0], [0, 0.6, -2.1]],
        halfWidth: 2.3, bottom: 0, top: 2.2,
      };
    case 'bridge': {
      const [dx, dz] = l.dir ?? [1, 0];
      const h = l.halfLen ?? 4;
      return { ...base, pts: [[0, 0.5, 0], [dx * h, 0.5, dz * h], [-dx * h, 0.5, -dz * h]], halfWidth: h, bottom: -0.6, top: 0.6 };
    }
    case 'monument':
      return { ...base, pts: [[0, 1, 0], [0, 2.5, 0], [0, 4, 0]], halfWidth: 1.2, bottom: 0, top: 4.6 };
  }
}

/** A rising smoke column (intersection missions). */
export function smokeTarget(x: number, y: number, z: number, id: number): SightTarget {
  return { id, x, y, z, pts: [[0, 6, 0], [0, 14, 0], [0, 22, 0], [0, 30, 0], [0, 38, 0]], halfWidth: 2.5, bottom: 0, top: 42 };
}

export type SightResult =
  | { kind: 'hit'; id: number; distance: number }
  | { kind: 'miss' } // something is visible, but the line of sight is not on it
  | { kind: 'none' }; // no titik ekstrem is visible from here at all

export class Sight {
  /** Per cell: the lowest and highest y blocked by vegetation (canopies, bushes). Bottom = Infinity if none. */
  private vegBot: Float32Array;
  private vegTop: Float32Array;
  readonly targets: SightTarget[];

  constructor(private w: WorldData) {
    const N = w.size;
    this.vegBot = new Float32Array(N * N).fill(Infinity);
    this.vegTop = new Float32Array(N * N).fill(-Infinity);
    const t = w.trees;
    for (let i = 0; i < t.length; i += 6) {
      const x = t[i], z = t[i + 1], y = t[i + 2], trunk = t[i + 3], size = t[i + 4], kind = t[i + 5];
      let bot: number, top: number, half: number;
      if (kind === 2) { bot = y; top = y + 0.5; half = 0; } // bush, its own cell
      else { bot = y + trunk; top = bot + (size === 5 ? 3 : 2); half = (size - 1) / 2; }
      for (let dz = -half; dz <= half; dz++) {
        for (let dx = -half; dx <= half; dx++) {
          const cx = Math.floor(x + dx), cz = Math.floor(z + dz);
          if (cx < 0 || cz < 0 || cx >= N || cz >= N) continue;
          const c = cz * N + cx;
          if (bot < this.vegBot[c]) this.vegBot[c] = bot;
          if (top > this.vegTop[c]) this.vegTop[c] = top;
        }
      }
    }
    this.targets = w.landmarks.map((l, i) => landmarkTarget(l, i));
  }

  /** Mission objects that can also be sighted (replaced at each mission start). */
  extra: SightTarget[] = [];

  /** True if nothing blocks the straight line from a to b. The last `skipEnd` blocks are ignored (the target itself). */
  lineClear(ax: number, ay: number, az: number, bx: number, by: number, bz: number, skipEnd = 1.5): boolean {
    const N = this.w.size;
    const H = this.w.height;
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const step = 0.25;
    const n = Math.floor((len - skipEnd) / step);
    for (let k = 2; k <= n; k++) {
      const t = (k * step) / len;
      const x = ax + dx * t, y = ay + dy * t, z = az + dz * t;
      const cx = Math.floor(x), cz = Math.floor(z);
      if (cx < 0 || cz < 0 || cx >= N || cz >= N) continue;
      const c = cz * N + cx;
      if (y < H[c]) return false;
      if (y >= this.vegBot[c] && y <= this.vegTop[c]) return false;
    }
    return true;
  }

  /** Can target `t` be seen from the eye at all (any of its sight points, within range)? */
  visible(t: SightTarget, ex: number, ey: number, ez: number, range: number): boolean {
    const hd = Math.hypot(t.x - ex, t.z - ez);
    if (hd > range) return false;
    return t.pts.some(([ox, oy, oz]) => this.lineClear(ex, ey, ez, t.x + ox, t.y + oy, t.z + oz));
  }

  /** Landmark ids visible from the eye (for picking good mission spots). */
  visibleLandmarks(ex: number, ey: number, ez: number, range: number): number[] {
    return this.targets.filter((t) => this.visible(t, ex, ey, ez, range)).map((t) => t.id);
  }

  /**
   * Which target (if any) is on the line of sight. `gridAz` is where the player aims (degrees),
   * `pitch` the vertical aim (radians, up positive).
   */
  sight(ex: number, ey: number, ez: number, gridAz: number, pitch: number, range: number): SightResult {
    let best = -1, bestErr = Infinity, bestDist = 0;
    let anyVisible = false;
    const p = pitch * DEG;
    for (const t of [...this.targets, ...this.extra]) {
      if (!this.visible(t, ex, ey, ez, range)) continue;
      anyVisible = true;
      const hd = Math.max(0.5, Math.hypot(t.x - ex, t.z - ez));
      const err = Math.abs(angleDiff(gridAz, azimuthTo(ex, ez, t.x, t.z)));
      // Identification only: a sighting a few degrees off still names the landmark (as in the field).
      // The recorded azimuth keeps the error, so it still shifts the drawn line and the fix.
      const tolerance = Math.max(3, Math.atan2(t.halfWidth, hd) * DEG + 1.5);
      const lo = Math.atan2(t.y + t.bottom - ey, hd) * DEG - 3;
      const hi = Math.atan2(t.y + t.top - ey, hd) * DEG + 3;
      if (err <= tolerance && p >= lo && p <= hi && err < bestErr) { best = t.id; bestErr = err; bestDist = hd; }
    }
    if (best >= 0) return { kind: 'hit', id: best, distance: bestDist };
    return anyVisible ? { kind: 'miss' } : { kind: 'none' };
  }

  /** Looks up a target by id (landmark index or mission object id). */
  target(id: number): SightTarget | undefined {
    return this.targets.find((t) => t.id === id) ?? this.extra.find((t) => t.id === id);
  }
}
