// Navtup team (GDD "The four roles"). The player is the compasman: the compass is locked on a bearing
// and the player directs the penerabas "kiri", "kanan", "lurus". The penerabas cuts the vegetation
// ahead, the sweeper widens the cut, the stringlineman leaves a line of posts. The penerabas drifts off
// line on his own, so the compasman has to keep correcting; a bad direction makes a crooked path.
// In level 5 the team walks by itself on the locked bearing for the number of steps the compasman
// sets: the penerabas fells the young trees on the line with his golok, the sweeper behind him clears
// the felled trees off the lane, and the lane is left as bare earth back to the path.
import * as THREE from 'three';
import { BLOCK_M, type WorldData } from '../gen/constants';
import type { ChunkManager } from '../world/chunks';
import { makeCharacter, type Character } from '../world/characters';
import { Lane, Stringline, youngTree } from '../world/objects3d';
import { angleDiff, magneticOf, norm360 } from '../tools/sight';
import type { Player } from '../player/player';

const CUT_SPEED = 2.0 / BLOCK_M; // 2 m/s while cutting a path
const STEER_RATE = 14; // degrees per second while "kiri"/"kanan" is held
const GAP = 3.2; // blocks between penerabas and compasman
const CHOP_TIME = 0.6; // seconds of golok work per young tree
const FALL_TIME = 0.7; // seconds for a felled tree to fall
const SWEEP_TIME = 0.9; // seconds for the sweeper to clear a felled tree off the lane

/** A felled tree: falls across the lane edge, then the sweeper pushes it clear. */
interface Fallen {
  obj: THREE.Object3D;
  base: THREE.Vector2;
  /** Unit vector (x, z) it falls toward and is swept along. */
  dir: THREE.Vector2;
  t: number;
  /** Sweep progress 0..1, or −1 before the sweeper reaches it. */
  swept: number;
}

export class Team {
  readonly group = new THREE.Group();
  active = false;
  /** True once the team is placed (atur posisi tim) and cutting on the bearing. */
  cutting = false;
  /** Penerabas heading, grid degrees. */
  heading = 0;
  /** Locked compass bearing, magnetic degrees (null until locked). */
  locked: number | null = null;
  steer = 0; // −1 left, 0 straight, +1 right
  blocked = false;
  stringline = new Stringline();
  /** Level 5: walk by yourself on the heading (the mission stops it after the set number of steps). */
  auto = false;
  /** Level 5: the penerabas fells the trees on the line; the sweeper clears them off the lane. */
  fell = false;
  /** Trees felled so far. */
  felledCount = 0;
  /** True while the penerabas is chopping (the team waits). */
  get chopping() { return this.chopTree >= 0; }
  private chopTree = -1;
  private chopLeft = 0;
  private side = 1;
  private fallen: Fallen[] = [];
  private lane = new Lane();
  private lastLane: THREE.Vector2 | null = null;

  private members: Record<'penerabas' | 'sweeper' | 'stringlineman', Character>;
  private lead = new THREE.Vector2();
  /** Path of the penerabas, for the others to follow. */
  private path: THREE.Vector2[] = [];
  private drift = 0;
  private lastPost: THREE.Vector2 | null = null;
  /** Lowest the leader may step: one block, like the player. */

  constructor(private w: WorldData, private chunks: ChunkManager) {
    this.members = {
      penerabas: makeCharacter('penerabas'),
      sweeper: makeCharacter('sweeper'),
      stringlineman: makeCharacter('stringlineman'),
    };
    for (const m of Object.values(this.members)) this.group.add(m.group);
    this.group.add(this.stringline.group, this.lane.mesh);
    this.group.visible = false;
  }

  /** Clears the team between missions: no stringline, nobody in the world. */
  reset() {
    this.group.remove(this.stringline.group);
    this.stringline = new Stringline();
    this.group.add(this.stringline.group);
    for (const f of this.fallen) this.group.remove(f.obj);
    this.fallen = [];
    this.group.remove(this.lane.mesh);
    this.lane = new Lane();
    this.group.add(this.lane.mesh);
    this.lastLane = null;
    this.chopTree = -1;
    this.felledCount = 0;
    this.auto = false;
    this.fell = false;
    this.active = false;
    this.cutting = false;
    this.steer = 0;
    this.locked = null;
    this.path = [];
    this.group.visible = false;
  }

  /** Brings the team next to the player (they walk along, following). */
  join(player: Player) {
    this.active = true;
    this.group.visible = true;
    this.path = [];
    for (let k = 0; k < 30; k++) this.path.push(new THREE.Vector2(player.x, player.z));
    this.lead.set(player.x, player.z);
  }

  /** Atur posisi tim: penerabas in front on the bearing, the rest behind the compasman. */
  place(player: Player, gridHeading: number) {
    this.join(player);
    this.cutting = true;
    this.heading = gridHeading;
    const r = (gridHeading * Math.PI) / 180;
    const dx = Math.sin(r), dz = -Math.cos(r);
    this.lead.set(player.x + dx * GAP, player.z + dz * GAP);
    this.path = [];
    for (let k = 20; k >= 0; k--) this.path.push(new THREE.Vector2(player.x + dx * (GAP - k * 0.5), player.z + dz * (GAP - k * 0.5)));
    this.lastPost = null;
    this.drift = 0;
    player.yaw = -r; // face the bearing, with the penerabas in view
    player.pitch = -0.05;
  }

  stopCutting() {
    this.auto = false;
    this.chopTree = -1;
    this.cutting = false;
    this.steer = 0;
    this.restartTrail = true;
  }

  /** After cutting stops, followers start a fresh trail behind the player. */
  private restartTrail = false;

  /** Deviation of the penerabas from the locked bearing, degrees (positive = right of the line). */
  deviation(): number | null {
    if (this.locked === null) return null;
    return angleDiff(magneticOf(this.heading), this.locked);
  }

  turn90(sign: number) {
    this.heading = norm360(this.heading + sign * 90);
  }

  /**
   * Advances the team. `forward` in [0, 1] (joystick or Maju). Moves the player along the cut path while
   * cutting; otherwise the team just follows the player.
   */
  update(dt: number, forward: number, player: Player, time: number) {
    if (!this.active) return;
    const N = this.w.size;
    this.blocked = false;

    let sweeping = false;
    if (this.cutting) {
      player.carried = true;
      // Walking by itself (level 5) the team keeps the locked heading; under the joystick the penerabas
      // wanders off the line by himself and the compasman corrects.
      if (this.auto) {
        forward = 1;
      } else if (this.fell) {
        forward = 0; // level 5: the team only moves for the steps the compasman set
      } else if (forward > 0.05) {
        this.drift += (Math.random() - 0.5) * dt * 7;
        this.drift *= 1 - Math.min(1, dt * 0.4);
        this.drift = Math.max(-3, Math.min(3, this.drift));
        this.heading = norm360(this.heading + (this.drift + this.steer * STEER_RATE) * dt);
      } else if (this.steer !== 0) {
        this.heading = norm360(this.heading + this.steer * STEER_RATE * dt);
      }
      const r = (this.heading * Math.PI) / 180;
      let step = CUT_SPEED * forward * dt;
      if (this.fell && step > 0) {
        // a trunk on the lane just ahead: stop and fell it with the golok
        if (this.chopTree < 0) {
          const fx = Math.sin(r), fz = -Math.cos(r), rx = Math.cos(r), rz = Math.sin(r);
          outer: for (const a of [0.7, 1.4]) {
            for (const l of [0, -0.7, 0.7]) {
              const i = this.chunks.treeIn(this.lead.x + fx * a + rx * l, this.lead.y + fz * a + rz * l);
              if (i >= 0) { this.chopTree = i; this.chopLeft = CHOP_TIME; break outer; }
            }
          }
        }
        if (this.chopTree >= 0) {
          step = 0;
          this.chopLeft -= dt;
          if (this.chopLeft <= 0) this.fellTree(this.chopTree, r);
        }
      }
      if (step > 0) {
        const nx = this.lead.x + Math.sin(r) * step;
        const nz = this.lead.y - Math.cos(r) * step;
        // Look a little ahead so the penerabas stops short of an obstacle, leaving room to turn and detour.
        const ax = nx + Math.sin(r) * 1.3, az = nz - Math.cos(r) * 1.3;
        const mx = nx + Math.sin(r) * 0.65, mz = nz - Math.cos(r) * 0.65;
        if (this.passable(this.lead.x, this.lead.y, nx, nz) && this.passable(nx, nz, mx, mz) && this.passable(mx, mz, ax, az)) {
          this.lead.set(nx, nz);
          // penerabas cuts the cell ahead; sweeper widens to both sides
          this.chunks.clearBush(nx + Math.sin(r) * 0.8, nz - Math.cos(r) * 0.8);
          this.chunks.clearBush(nx, nz);
          this.chunks.clearBush(nx + Math.cos(r) * 1, nz + Math.sin(r) * 1);
          this.chunks.clearBush(nx - Math.cos(r) * 1, nz - Math.sin(r) * 1);
          const last = this.path[this.path.length - 1];
          if (!last || last.distanceTo(this.lead) > 0.25) this.path.push(this.lead.clone());
        } else {
          this.blocked = true;
        }
      }
      // compasman (player) walks GAP behind the penerabas on the cut path
      const pp = this.pointBehind(GAP);
      player.carryTo(pp.x, pp.y);
      if (this.fell) sweeping = this.updateFallen(dt);
    } else {
      player.carried = false;
      // follow the player: the player's own trail becomes the path
      const here = new THREE.Vector2(player.x, player.z);
      if (this.restartTrail) {
        // line the followers up behind the player, opposite to where they look
        const bx = Math.sin(player.yaw), bz = Math.cos(player.yaw);
        this.path = [];
        for (let k = 12; k >= 1; k--) this.path.push(new THREE.Vector2(player.x + bx * k * 0.5, player.z + bz * k * 0.5));
        this.restartTrail = false;
      }
      const last = this.path[this.path.length - 1];
      if (!last || last.distanceTo(here) > 0.3) this.path.push(here);
      this.lead.copy(this.pointBehind(-0.01));
    }
    if (this.path.length > 3000) this.path.splice(0, this.path.length - 3000);

    // place the three NPCs along the path
    const behindPlayer = this.cutting ? GAP : 0;
    const spots: [Character, THREE.Vector2][] = [
      [this.members.penerabas, this.cutting ? this.lead : this.pointBehind(-1.2, true)],
      [this.members.sweeper, this.pointBehind(behindPlayer + 1.8)],
      [this.members.stringlineman, this.pointBehind(behindPlayer + 3.4)],
    ];
    for (const [c, p] of spots) {
      const prev = c.group.position.clone();
      const y = this.groundAt(p.x, p.y);
      c.group.position.set(p.x, y, p.y);
      const mv = Math.hypot(p.x - prev.x, p.y - prev.z);
      if (mv > 0.002) c.group.rotation.y = Math.atan2(-(p.x - prev.x), -(p.y - prev.z));
      if ((c === this.members.penerabas && this.chopTree >= 0) || (c === this.members.sweeper && sweeping)) c.work(dt);
      else c.animate(dt, Math.min(2, mv / Math.max(dt, 1e-3)));
    }
    if (!this.cutting) {
      // when following, the penerabas walks beside the player, facing the same way
      const pen = this.members.penerabas.group;
      pen.position.set(player.x + Math.cos(player.yaw) * 0.8, this.groundAt(player.x + Math.cos(player.yaw) * 0.8, player.z - Math.sin(player.yaw) * 0.8), player.z - Math.sin(player.yaw) * 0.8);
      pen.rotation.y = player.yaw;
    }

    // stringline posts every 4 blocks where the stringlineman walks (only while cutting)
    if (this.cutting) {
      const s = this.pointBehind(GAP + 3.4);
      if (!this.lastPost || this.lastPost.distanceTo(s) >= 4) {
        this.stringline.add(s.x, this.groundAt(s.x, s.y), s.y);
        this.lastPost = s.clone();
      }
    }
    void N;
    void time;
  }

  /** The penerabas fells tree `i` (index into w.trees): it falls forward and to one side of the lane. */
  private fellTree(i: number, r: number) {
    const t = this.w.trees;
    this.chunks.fellTree(i);
    this.chopTree = -1;
    this.felledCount++;
    this.side = -this.side;
    const dir = new THREE.Vector2(Math.sin(r) * 0.5 + Math.cos(r) * this.side, -Math.cos(r) * 0.5 + Math.sin(r) * this.side).normalize();
    const obj = youngTree(t[i + 3]);
    obj.position.set(t[i], t[i + 2], t[i + 1]);
    this.group.add(obj);
    this.fallen.push({ obj, base: new THREE.Vector2(t[i], t[i + 1]), dir, t: 0, swept: -1 });
  }

  /**
   * Felled trees fall, then the sweeper (walking behind the compasman) pushes each one off the lane
   * and the swept lane is laid down as bare earth. Returns true while the sweeper is at work.
   */
  private updateFallen(dt: number): boolean {
    const sw = this.pointBehind(GAP + 1.8);
    let busy = false;
    for (const f of this.fallen) {
      f.t += dt;
      const k = Math.min(1, f.t / FALL_TIME);
      const axis = new THREE.Vector3(f.dir.y, 0, -f.dir.x);
      f.obj.quaternion.setFromAxisAngle(axis, 1.45 * k * k);
      if (k < 1) continue;
      if (f.swept < 0 && sw.distanceTo(f.base) < 2.2) f.swept = 0;
      if (f.swept >= 0 && f.swept < 1) {
        busy = true;
        f.swept = Math.min(1, f.swept + dt / SWEEP_TIME);
        const e = f.swept * (2 - f.swept);
        const x = f.base.x + f.dir.x * 2.2 * e, z = f.base.y + f.dir.y * 2.2 * e;
        f.obj.position.set(x, this.groundAt(x, z), z);
      }
    }
    if (!this.lastLane || this.lastLane.distanceTo(sw) >= 0.5) {
      const prev = this.lastLane ?? sw;
      const h = prev === sw ? this.heading : (Math.atan2(sw.x - prev.x, -(sw.y - prev.y)) * 180) / Math.PI;
      this.lane.add(sw.x, this.groundAt(sw.x, sw.y), sw.y, h);
      this.lastLane = sw.clone();
    }
    return busy;
  }

  /** Point on the path `d` blocks behind its end (negative = ahead of the end, along the last direction). */
  private pointBehind(d: number, clampAhead = false): THREE.Vector2 {
    const path = this.path;
    if (path.length === 0) return this.lead.clone();
    if (d <= 0) {
      const a = path[path.length - 1];
      if (clampAhead || path.length < 2) return a.clone();
      return a.clone();
    }
    let rem = d;
    for (let k = path.length - 1; k > 0; k--) {
      const a = path[k], b = path[k - 1];
      const seg = a.distanceTo(b);
      if (seg >= rem) return a.clone().lerp(b, rem / seg);
      rem -= seg;
    }
    return path[0].clone();
  }

  private groundAt(x: number, z: number): number {
    const N = this.w.size;
    const xi = Math.max(0, Math.min(N - 1, Math.floor(x))), zi = Math.max(0, Math.min(N - 1, Math.floor(z)));
    const i = zi * N + xi;
    return Math.max(this.w.height[i], this.w.deck[i]);
  }

  private passable(x0: number, z0: number, x: number, z: number): boolean {
    const N = this.w.size;
    if (x < 1 || z < 1 || x > N - 1 || z > N - 1) return false;
    const i = Math.floor(z) * N + Math.floor(x);
    if (this.w.water[i] >= 0 && this.w.deck[i] < 0) return false; // cannot cut across a river
    // The team scrambles up to two blocks (5 m) like a player jumping; higher walls need a detour.
    const h0 = this.groundAt(x0, z0);
    return this.groundAt(x, z) - h0 <= 2.05;
  }
}
