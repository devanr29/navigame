// Navtup team (GDD "The four roles"). The player is the compasman: the compass is locked on a bearing
// and the player directs the penerabas "kiri", "kanan", "lurus". The penerabas cuts the vegetation
// ahead, the sweeper widens the cut, the stringlineman leaves a line of posts. The penerabas drifts off
// line on his own, so the compasman has to keep correcting; a bad direction makes a crooked path.
import * as THREE from 'three';
import { BLOCK_M, type WorldData } from '../gen/constants';
import type { ChunkManager } from '../world/chunks';
import { makeCharacter, type Character } from '../world/characters';
import { Stringline } from '../world/objects3d';
import { angleDiff, magneticOf, norm360 } from '../tools/sight';
import type { Player } from '../player/player';

const CUT_SPEED = 2.0 / BLOCK_M; // 2 m/s while cutting a path
const STEER_RATE = 14; // degrees per second while "kiri"/"kanan" is held
const GAP = 3.2; // blocks between penerabas and compasman

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
  /** Obstacle cells (thicket) that even the penerabas cannot cut. */
  hard = new Set<number>();
  stringline = new Stringline();

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
    this.group.add(this.stringline.group);
    this.group.visible = false;
  }

  /** Clears the team between missions: no stringline, nobody in the world. */
  reset() {
    this.group.remove(this.stringline.group);
    this.stringline = new Stringline();
    this.group.add(this.stringline.group);
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

    if (this.cutting) {
      player.carried = true;
      // the penerabas wanders off the line by himself; the compasman corrects
      if (forward > 0.05) {
        this.drift += (Math.random() - 0.5) * dt * 7;
        this.drift *= 1 - Math.min(1, dt * 0.4);
        this.drift = Math.max(-3, Math.min(3, this.drift));
        this.heading = norm360(this.heading + (this.drift + this.steer * STEER_RATE) * dt);
      } else if (this.steer !== 0) {
        this.heading = norm360(this.heading + this.steer * STEER_RATE * dt);
      }
      const r = (this.heading * Math.PI) / 180;
      const step = CUT_SPEED * forward * dt;
      if (step > 0) {
        const nx = this.lead.x + Math.sin(r) * step;
        const nz = this.lead.y - Math.cos(r) * step;
        // Look a little ahead so the penerabas stops short of an obstacle, leaving room to turn and detour.
        const ax = nx + Math.sin(r) * 1.3, az = nz - Math.cos(r) * 1.3;
        if (this.passable(this.lead.x, this.lead.y, nx, nz) && this.passable(nx, nz, ax, az)) {
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
      c.animate(dt, Math.min(2, mv / Math.max(dt, 1e-3)));
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
    if (this.hard.has(i)) return false;
    if (this.w.water[i] >= 0 && this.w.deck[i] < 0) return false; // cannot cut across a river
    // The team scrambles up to two blocks (5 m) like a player jumping; higher walls need a detour.
    const h0 = this.groundAt(x0, z0);
    return this.groundAt(x, z) - h0 <= 2.05;
  }
}
