// Navtup team (GDD "The four roles"). Marching order on the lane: penerabas, sweeper, compasman,
// stringlineman. The player is the compasman: the compass is locked on a bearing and he sights the
// penerabas through it. The penerabas cuts the vegetation ahead and the sweeper right behind him clears
// the lane; they set off first, and the compasman and stringlineman only follow once the lane in front
// of them is clear. The penerabas veers off the line on his own, so the compasman keeps correcting him
// with a sidestep call: "jalan ke kiri 1 langkah". The stringlineman, last, leaves a line of posts.
// In level 5 the team walks by itself on the locked bearing for the number of steps the compasman
// sets (the compasman calls the corrections himself): the penerabas fells the young trees on the line
// with his golok, the sweeper clears the felled trees off the lane, and the lane is left as bare earth
// back to the path.
import * as THREE from 'three';
import { BLOCK_M, type WorldData } from '../gen/constants';
import type { ChunkManager } from '../world/chunks';
import { makeCharacter, type Character } from '../world/characters';
import { Lane, Stringline, youngTree } from '../world/objects3d';
import { angleDiff, azimuthTo, magneticOf, norm360 } from '../tools/sight';
import { DEFAULT_PACE } from './pace';
import type { Player } from '../player/player';

const CUT_SPEED = 2.0 / BLOCK_M; // 2 m/s while cutting a path
const FOLLOW_SPEED = CUT_SPEED * 1.5; // the others catch up a little faster on the cleared lane
const SIDESTEP_SPEED = 1.2 / BLOCK_M; // penerabas stepping sideways on a call
const LEAD0 = 2.3; // blocks the penerabas starts ahead of the compasman
const SWEEP0 = 0.9; // blocks the sweeper starts ahead of the compasman
const SWEEP_GAP = 1.4; // sweeper this far behind the penerabas
const COMP_GAP = 3.6; // compasman waits until the penerabas is this far ahead on the lane
const STRING_GAP = 1.6; // stringlineman this far behind the compasman
const MAX_VEER = 10; // degrees the penerabas wanders off his heading at most
const CALL_TIME = 2.6; // seconds a call stays on screen
const CALL_COOLDOWN = 1.6; // seconds between the compasman's own calls (level 5)
const CHOP_TIME = 0.6; // seconds of golok work per young tree
const FALL_TIME = 0.7; // seconds for a felled tree to fall
const SWEEP_TIME = 0.9; // seconds for the sweeper to clear a felled tree off the lane

/** A felled tree: falls across the lane edge, then the sweeper pushes it clear. */
interface Fallen {
  obj: THREE.Object3D;
  base: THREE.Vector2;
  /** Position along the lane (path arc length). */
  s: number;
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
  /** Penerabas heading, grid degrees (the locked bearing, or a 90° detour leg). */
  heading = 0;
  /** Locked compass bearing, magnetic degrees (null until locked). */
  locked: number | null = null;
  blocked = false;
  stringline = new Stringline();
  /** Stride in metres, to turn the penerabas' offset into steps (set from the pace calibration). */
  stride = 100 / DEFAULT_PACE;
  /** Level 5: walk by yourself on the heading (the mission stops it after the set number of steps). */
  auto = false;
  /** Level 5: the penerabas fells the trees on the line; the sweeper clears them off the lane. */
  fell = false;
  /** Trees felled so far. */
  felledCount = 0;
  /** The compasman's last call to the penerabas, while it is on screen. */
  call: string | null = null;
  /** Calls the compasman gave. */
  callCount = 0;
  /** True while the penerabas is chopping (the team waits). */
  get chopping() { return this.chopTree >= 0; }
  /** True while the compasman waits for the penerabas and sweeper to clear the lane ahead. */
  waiting = false;
  private callLeft = 0;
  private callCool = 0;
  private chopTree = -1;
  private chopLeft = 0;
  private side = 1;
  private fallen: Fallen[] = [];
  private lane = new Lane();
  private laneS: number | null = null;

  private members: Record<'penerabas' | 'sweeper' | 'stringlineman', Character>;
  private lead = new THREE.Vector2();
  /** Path of the penerabas, for the others to follow, with the arc length of each point. */
  private path: THREE.Vector2[] = [];
  private pathS: number[] = [];
  /** Positions along the path (arc length) of the sweeper, compasman and stringlineman while cutting. */
  private swS = 0;
  private compS = 0;
  private strS = 0;
  /** Degrees the penerabas walks off his heading; he does not notice, the compasman does. */
  private veer = 0;
  /** Sidestep in progress: −1 left, +1 right, and the blocks still to go. */
  private sidestep: { dir: number; left: number } | null = null;
  private lastPost: THREE.Vector2 | null = null;

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
    this.laneS = null;
    this.chopTree = -1;
    this.felledCount = 0;
    this.auto = false;
    this.fell = false;
    this.active = false;
    this.cutting = false;
    this.waiting = false;
    this.sidestep = null;
    this.call = null;
    this.callCount = 0;
    this.locked = null;
    this.path = [];
    this.pathS = [];
    this.group.visible = false;
  }

  /** Brings the team next to the player (they walk along, following). */
  join(player: Player) {
    this.active = true;
    this.group.visible = true;
    this.path = [];
    this.pathS = [];
    for (let k = 0; k < 30; k++) this.push(new THREE.Vector2(player.x, player.z), true);
    this.lead.set(player.x, player.z);
  }

  /**
   * Atur posisi tim: one file on the bearing. Penerabas in front, sweeper behind him, then the
   * compasman (the player) and the stringlineman last.
   */
  place(player: Player, gridHeading: number) {
    this.join(player);
    this.cutting = true;
    this.heading = gridHeading;
    const r = (gridHeading * Math.PI) / 180;
    const dx = Math.sin(r), dz = -Math.cos(r);
    this.path = [];
    this.pathS = [];
    for (let s = -(STRING_GAP + 4); s < LEAD0; s += 0.5) this.pushAt(player.x + dx * s, player.z + dz * s, s);
    this.pushAt(player.x + dx * LEAD0, player.z + dz * LEAD0, LEAD0);
    this.lead.set(player.x + dx * LEAD0, player.z + dz * LEAD0);
    this.swS = SWEEP0;
    this.compS = 0;
    this.strS = -STRING_GAP;
    this.lastPost = null;
    this.veer = 0;
    this.sidestep = null;
    this.call = null;
    this.callCool = CALL_COOLDOWN;
    player.yaw = -r; // face the bearing, with the penerabas in view
    player.pitch = -0.05;
  }

  stopCutting() {
    this.auto = false;
    this.chopTree = -1;
    this.cutting = false;
    this.waiting = false;
    this.sidestep = null;
    this.restartTrail = true;
  }

  /** After cutting stops, followers start a fresh trail behind the player. */
  private restartTrail = false;

  /**
   * Where the compasman sees the penerabas through the locked compass, degrees off the bearing
   * (positive = right of the line).
   */
  deviation(): number | null {
    if (this.locked === null) return null;
    const c = this.pointAt(this.compS);
    if (c.distanceTo(this.lead) < 0.5) return 0;
    return angleDiff(magneticOf(azimuthTo(c.x, c.y, this.lead.x, this.lead.y)), this.locked);
  }

  /** How far the penerabas stands off the line, in steps (positive = right of the line). */
  offsetSteps(): number | null {
    const dev = this.deviation();
    if (dev === null) return null;
    const d = this.pointAt(this.compS).distanceTo(this.lead);
    return (d * Math.sin((dev * Math.PI) / 180) * BLOCK_M) / this.stride;
  }

  /** The step count the compasman should call to bring the penerabas back on the line (null: on it). */
  correction(): { dir: number; steps: number } | null {
    const dev = this.deviation(), off = this.offsetSteps();
    if (dev === null || off === null || Math.abs(dev) > 45) return null;
    const steps = Math.round(Math.abs(off));
    return steps >= 1 ? { dir: off > 0 ? -1 : 1, steps } : null;
  }

  /** Compasman's call: the penerabas steps `steps` to the left (−1) or right (+1) of his heading. */
  command(dir: number, steps = 1) {
    if (!this.cutting) return;
    this.say(`Jalan ke ${dir < 0 ? 'kiri' : 'kanan'} ${steps} langkah!`);
    this.callCount++;
    this.sidestep = { dir, left: (steps * this.stride) / BLOCK_M };
    this.veer = (Math.random() - 0.5) * 2; // he looks again and walks straight on
  }

  private say(text: string) {
    this.call = text;
    this.callLeft = CALL_TIME;
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
    this.blocked = false;
    if (this.call && (this.callLeft -= dt) <= 0) this.call = null;

    let sweeping = false;
    if (this.cutting) {
      player.carried = true;
      // Walking by itself (level 5) the team moves only for the steps the compasman set; otherwise
      // under the joystick.
      if (this.auto) forward = 1;
      else if (this.fell) forward = 0;
      const r = (this.heading * Math.PI) / 180;
      const rx = Math.cos(r), rz = Math.sin(r);

      // level 5: the compasman watches the penerabas and calls the sidestep himself
      this.callCool -= dt;
      if (this.auto && !this.sidestep && this.callCool <= 0) {
        const c = this.correction();
        if (c) { this.command(c.dir, c.steps); this.callCool = CALL_COOLDOWN; }
      }

      // the penerabas keeps the team together: he waits for the sweeper and the compasman
      const tooFar = this.leadS() - this.swS > SWEEP_GAP + 2 || this.leadS() - this.compS > COMP_GAP + 2.5;
      if (this.sidestep) {
        // sidestep on the call, cutting as he goes (also while the others stand)
        const step = Math.min(this.sidestep.left, SIDESTEP_SPEED * dt);
        const nx = this.lead.x + rx * this.sidestep.dir * step, nz = this.lead.y + rz * this.sidestep.dir * step;
        if (this.passable(this.lead.x, this.lead.y, nx, nz)) {
          this.moveLead(nx, nz, r);
          this.sidestep.left -= step;
          if (this.sidestep.left <= 1e-4) {
            this.sidestep = null;
            if (this.auto) this.say('Pas, lurus terus!');
          }
        } else this.sidestep = null;
      } else if (forward > 0.05 && !tooFar) {
        let step = CUT_SPEED * forward * dt;
        if (this.fell) {
          // a trunk on the lane just ahead: stop and fell it with the golok
          if (this.chopTree < 0) {
            const fx = Math.sin(r), fz = -Math.cos(r);
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
          // he wanders off his heading without noticing
          this.veer += (Math.random() - 0.5) * dt * 30;
          this.veer = Math.max(-MAX_VEER, Math.min(MAX_VEER, this.veer));
          const v = r + (this.veer * Math.PI) / 180;
          const nx = this.lead.x + Math.sin(v) * step;
          const nz = this.lead.y - Math.cos(v) * step;
          // Look a little ahead so the penerabas stops short of an obstacle, leaving room to turn and detour.
          const ax = nx + Math.sin(v) * 1.3, az = nz - Math.cos(v) * 1.3;
          const mx = nx + Math.sin(v) * 0.65, mz = nz - Math.cos(v) * 0.65;
          if (this.passable(this.lead.x, this.lead.y, nx, nz) && this.passable(nx, nz, mx, mz) && this.passable(mx, mz, ax, az)) {
            this.moveLead(nx, nz, v);
          } else {
            this.blocked = true;
          }
        }
      }

      // The others follow on the lane the penerabas and sweeper opened. The sweeper stops to clear each
      // felled tree; the compasman waits until the lane ahead of him is clear and the penerabas is far
      // enough ahead to sight; the stringlineman walks behind the compasman.
      const move = FOLLOW_SPEED * forward * dt;
      if (this.fell) sweeping = this.sweep(dt);
      if (!sweeping) this.swS = Math.max(this.swS, Math.min(this.leadS() - SWEEP_GAP, this.swS + move));
      let compTo = Math.min(this.leadS() - COMP_GAP, this.swS - 1);
      for (const f of this.fallen) if (f.swept < 1) compTo = Math.min(compTo, f.s - 1.5);
      this.waiting = forward > 0.05 && compTo <= this.compS + 1e-3;
      this.compS = Math.max(this.compS, Math.min(compTo, this.compS + move));
      this.strS = Math.max(this.strS, Math.min(this.compS - STRING_GAP, this.strS + move));
      const pp = this.pointAt(this.compS);
      player.carryTo(pp.x, pp.y);
      if (this.fell) this.layLane();
    } else {
      player.carried = false;
      // follow the player: the player's own trail becomes the path
      const here = new THREE.Vector2(player.x, player.z);
      if (this.restartTrail) {
        // line the followers up behind the player, opposite to where they look
        const bx = Math.sin(player.yaw), bz = Math.cos(player.yaw);
        this.path = [];
        this.pathS = [];
        for (let k = 12; k >= 1; k--) this.push(new THREE.Vector2(player.x + bx * k * 0.5, player.z + bz * k * 0.5));
        this.restartTrail = false;
      }
      const last = this.path[this.path.length - 1];
      if (!last || last.distanceTo(here) > 0.3) this.push(here);
      this.lead.copy(here);
    }
    if (this.path.length > 3000) {
      this.path.splice(0, this.path.length - 3000);
      this.pathS.splice(0, this.pathS.length - 3000);
    }

    // place the three NPCs: on the lane while cutting, behind the player while following
    const end = this.leadS();
    const spots: [Character, THREE.Vector2][] = this.cutting
      ? [
          [this.members.penerabas, this.lead],
          [this.members.sweeper, this.pointAt(this.swS)],
          [this.members.stringlineman, this.pointAt(this.strS)],
        ]
      : [
          [this.members.penerabas, this.lead],
          [this.members.sweeper, this.pointAt(end - 1.8)],
          [this.members.stringlineman, this.pointAt(end - 3.4)],
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
    const pen = this.members.penerabas.group;
    if (this.cutting) {
      pen.rotation.y = (-this.heading * Math.PI) / 180; // faces the heading, also while sidestepping
    } else {
      // when following, the penerabas walks beside the player, facing the same way
      pen.position.set(player.x + Math.cos(player.yaw) * 0.8, this.groundAt(player.x + Math.cos(player.yaw) * 0.8, player.z - Math.sin(player.yaw) * 0.8), player.z - Math.sin(player.yaw) * 0.8);
      pen.rotation.y = player.yaw;
    }

    // stringline posts every 4 blocks where the stringlineman walks (only while cutting)
    if (this.cutting) {
      const s = this.pointAt(this.strS);
      if (!this.lastPost || this.lastPost.distanceTo(s) >= 4) {
        this.stringline.add(s.x, this.groundAt(s.x, s.y), s.y);
        this.lastPost = s.clone();
      }
    }
    void time;
  }

  /** Moves the penerabas to (x, z) facing grid angle `r` (radians): he cuts ahead, the cut is the lane. */
  private moveLead(x: number, z: number, r: number) {
    this.lead.set(x, z);
    this.chunks.clearBush(x + Math.sin(r) * 0.8, z - Math.cos(r) * 0.8);
    this.chunks.clearBush(x, z);
    // the sweeper behind him widens the cut to both sides
    const sw = this.pointAt(this.swS), sr = (this.heading * Math.PI) / 180;
    this.chunks.clearBush(sw.x + Math.cos(sr), sw.y + Math.sin(sr));
    this.chunks.clearBush(sw.x - Math.cos(sr), sw.y - Math.sin(sr));
    const last = this.path[this.path.length - 1];
    if (!last || last.distanceTo(this.lead) > 0.25) this.push(this.lead.clone());
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
    const ahead = (t[i] - this.lead.x) * Math.sin(r) - (t[i + 1] - this.lead.y) * Math.cos(r);
    this.fallen.push({ obj, base: new THREE.Vector2(t[i], t[i + 1]), s: this.leadS() + Math.max(0, ahead), dir, t: 0, swept: -1 });
  }

  /**
   * Felled trees fall, then the sweeper (right behind the penerabas) pushes each one off the lane
   * before the compasman comes up. Returns true while the sweeper is at work.
   */
  private sweep(dt: number): boolean {
    let busy = false;
    for (const f of this.fallen) {
      f.t += dt;
      const k = Math.min(1, f.t / FALL_TIME);
      const axis = new THREE.Vector3(f.dir.y, 0, -f.dir.x);
      f.obj.quaternion.setFromAxisAngle(axis, 1.45 * k * k);
      if (k < 1) continue;
      if (f.swept < 0 && this.swS >= f.s - 1.2) f.swept = 0;
      if (f.swept >= 0 && f.swept < 1) {
        busy = true;
        f.swept = Math.min(1, f.swept + dt / SWEEP_TIME);
        const e = f.swept * (2 - f.swept);
        const x = f.base.x + f.dir.x * 2.2 * e, z = f.base.y + f.dir.y * 2.2 * e;
        f.obj.position.set(x, this.groundAt(x, z), z);
      }
    }
    return busy;
  }

  /** The swept lane behind the sweeper is laid down as bare earth, from where the compasman started. */
  private layLane() {
    if (this.laneS === null) this.laneS = Math.min(0, this.swS) - 0.5;
    while (this.laneS + 0.5 <= this.swS) {
      const a = this.pointAt(this.laneS), b = this.pointAt(this.laneS + 0.5);
      const h = a.distanceTo(b) < 1e-3 ? this.heading : (Math.atan2(b.x - a.x, -(b.y - a.y)) * 180) / Math.PI;
      this.lane.add(b.x, this.groundAt(b.x, b.y), b.y, h);
      this.laneS += 0.5;
    }
  }

  private leadS(): number {
    return this.pathS.length ? this.pathS[this.pathS.length - 1] : 0;
  }

  private push(p: THREE.Vector2, same = false) {
    const last = this.path[this.path.length - 1];
    const s = last ? this.leadS() + (same ? 0 : last.distanceTo(p)) : 0;
    this.path.push(p);
    this.pathS.push(s);
  }

  private pushAt(x: number, z: number, s: number) {
    this.path.push(new THREE.Vector2(x, z));
    this.pathS.push(s);
  }

  /** Point on the path at arc length `s` (clamped to its ends). */
  private pointAt(s: number): THREE.Vector2 {
    const path = this.path, ps = this.pathS;
    if (path.length === 0) return this.lead.clone();
    if (s >= ps[ps.length - 1]) return path[path.length - 1].clone();
    for (let k = path.length - 1; k > 0; k--) {
      if (ps[k - 1] <= s) {
        const seg = ps[k] - ps[k - 1];
        return path[k - 1].clone().lerp(path[k], seg > 1e-6 ? (s - ps[k - 1]) / seg : 1);
      }
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
