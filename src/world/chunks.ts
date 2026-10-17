// Voxel terrain in 64 x 64 chunks with greedy meshing, plus per-chunk instanced trees.
import * as THREE from 'three';
import type { WorldData } from '../gen/constants';
import { FACE_SHADE, PLANK, SIDE, TOP, WATER } from './colors';
import { GeoBuilder, unitBox } from './mesh';

export const CHUNK = 64;
/** Trunks and bushes are only drawn within this distance (blocks); far forest shows canopies only. */
const DETAIL_DIST = 90;

const terrainMat = new THREE.MeshBasicMaterial({ vertexColors: true });
const waterMat = new THREE.MeshBasicMaterial({ color: WATER, transparent: true, opacity: 0.78, depthWrite: false });
const treeMat = new THREE.MeshBasicMaterial({ vertexColors: true });
const boxGeo = unitBox();

interface Chunk {
  group: THREE.Group;
  detail: THREE.Object3D[];
  /** Tree and bush meshes (rebuilt when the vegetation is restored). */
  trees: THREE.Object3D[];
  cx: number;
  cz: number;
}

export class ChunkManager {
  private chunks = new Map<number, Chunk>();
  private treeBuckets: number[][];
  private nC: number;
  readonly root = new THREE.Group();
  /** Chunks built so far (for the loading bar). */
  built = 0;
  /** 1 where an uncut bush (undergrowth) stands. The penerabas and sweeper clear them. */
  readonly bushGrid: Uint8Array;
  private bushInst = new Map<number, { mesh: THREE.InstancedMesh; k: number }>();
  /** Per cell: index into w.trees of the tree (not bush) standing there, or −1. */
  private treeAt: Int32Array;
  /** Trees felled by the penerabas (indices into w.trees), hidden until the vegetation is restored. */
  private felled = new Set<number>();
  private treeInst = new Map<number, { mesh: THREE.InstancedMesh; k: number }[]>();

  constructor(private w: WorldData) {
    this.nC = Math.ceil(w.size / CHUNK);
    this.treeBuckets = Array.from({ length: this.nC * this.nC }, () => []);
    const t = w.trees;
    this.bushGrid = new Uint8Array(w.size * w.size);
    this.treeAt = new Int32Array(w.size * w.size).fill(-1);
    for (let i = 0; i < t.length; i += 6) {
      const cell = Math.floor(t[i + 1]) * w.size + Math.floor(t[i]);
      if (t[i + 5] === 2) this.bushGrid[cell] = 1;
      else this.treeAt[cell] = i;
      const cx = Math.floor(t[i] / CHUNK);
      const cz = Math.floor(t[i + 1] / CHUNK);
      this.treeBuckets[cz * this.nC + cx].push(i);
    }
  }

  /**
   * Loads chunks within `radius` blocks of (px, pz), nearest first, at most `budget` per call,
   * and unloads chunks that are well beyond it.
   */
  update(px: number, pz: number, radius: number, budget: number) {
    const want: [number, number, number][] = [];
    const r = Math.ceil(radius / CHUNK) + 1;
    const pcx = Math.floor(px / CHUNK);
    const pcz = Math.floor(pz / CHUNK);
    for (let cz = pcz - r; cz <= pcz + r; cz++) {
      for (let cx = pcx - r; cx <= pcx + r; cx++) {
        if (cx < 0 || cz < 0 || cx >= this.nC || cz >= this.nC) continue;
        const d = this.chunkDist(cx, cz, px, pz);
        if (d <= radius && !this.chunks.has(cz * this.nC + cx)) want.push([d, cx, cz]);
      }
    }
    want.sort((a, b) => a[0] - b[0]);
    for (let k = 0; k < Math.min(budget, want.length); k++) this.load(want[k][1], want[k][2]);

    for (const [key, c] of this.chunks) {
      const d = this.chunkDist(c.cx, c.cz, px, pz);
      if (d > radius + CHUNK) {
        this.unload(key, c);
        continue;
      }
      const near = d < DETAIL_DIST;
      for (const o of c.detail) o.visible = near;
    }
    return want.length - Math.min(budget, want.length);
  }

  private chunkDist(cx: number, cz: number, px: number, pz: number) {
    // distance from the point to the chunk rectangle
    const x0 = cx * CHUNK, z0 = cz * CHUNK;
    const dx = Math.max(x0 - px, 0, px - (x0 + CHUNK));
    const dz = Math.max(z0 - pz, 0, pz - (z0 + CHUNK));
    return Math.sqrt(dx * dx + dz * dz);
  }

  private load(cx: number, cz: number) {
    const group = new THREE.Group();
    const { terrain, water } = buildTerrain(this.w, cx, cz);
    group.add(new THREE.Mesh(terrain, terrainMat));
    if (water) {
      const wm = new THREE.Mesh(water, waterMat);
      wm.renderOrder = 1;
      group.add(wm);
    }
    const { detail, all } = this.buildTrees(group, this.treeBuckets[cz * this.nC + cx]);
    this.root.add(group);
    this.chunks.set(cz * this.nC + cx, { group, detail, trees: all, cx, cz });
    this.built++;
  }

  /** Cuts the bush in a cell, if any. Returns true if something was cut. */
  clearBush(x: number, z: number): boolean {
    const N = this.w.size;
    const xi = Math.floor(x), zi = Math.floor(z);
    if (xi < 0 || zi < 0 || xi >= N || zi >= N) return false;
    const cell = zi * N + xi;
    if (!this.bushGrid[cell]) return false;
    this.bushGrid[cell] = 0;
    const inst = this.bushInst.get(cell);
    if (inst) {
      inst.mesh.setMatrixAt(inst.k, new THREE.Matrix4().makeScale(0, 0, 0));
      inst.mesh.instanceMatrix.needsUpdate = true;
      this.bushInst.delete(cell);
    }
    return true;
  }

  /** The standing tree whose trunk is in this cell: index into w.trees, or −1. */
  treeIn(x: number, z: number): number {
    const N = this.w.size;
    const xi = Math.floor(x), zi = Math.floor(z);
    if (xi < 0 || zi < 0 || xi >= N || zi >= N) return -1;
    const i = this.treeAt[zi * N + xi];
    return i >= 0 && !this.felled.has(i) ? i : -1;
  }

  /** Fells a tree (index into w.trees): hides it and frees its cell. */
  fellTree(i: number) {
    if (this.felled.has(i)) return;
    this.felled.add(i);
    const t = this.w.trees;
    this.w.solid[Math.floor(t[i + 1]) * this.w.size + Math.floor(t[i])] = 0;
    for (const { mesh, k } of this.treeInst.get(i) ?? []) {
      mesh.setMatrixAt(k, new THREE.Matrix4().makeScale(0, 0, 0));
      mesh.instanceMatrix.needsUpdate = true;
    }
    this.treeInst.delete(i);
  }

  /** Puts back every felled tree and cut bush (a fresh forest for the next mission). */
  restoreVegetation() {
    const t = this.w.trees, N = this.w.size;
    for (const i of this.felled) this.w.solid[Math.floor(t[i + 1]) * N + Math.floor(t[i])] = 1;
    this.felled.clear();
    for (let i = 0; i < t.length; i += 6) if (t[i + 5] === 2) this.bushGrid[Math.floor(t[i + 1]) * N + Math.floor(t[i])] = 1;
    for (const c of this.chunks.values()) {
      for (const o of c.trees) {
        c.group.remove(o);
        (o as THREE.InstancedMesh).dispose();
      }
      const near = c.detail.length ? c.detail[0].visible : false;
      const { detail, all } = this.buildTrees(c.group, this.treeBuckets[c.cz * this.nC + c.cx]);
      for (const o of detail) o.visible = near;
      c.detail = detail;
      c.trees = all;
    }
  }

  private unload(key: number, c: Chunk) {
    this.root.remove(c.group);
    c.group.traverse((o) => {
      if (o instanceof THREE.InstancedMesh) o.dispose();
      else if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    this.chunks.delete(key);
  }

  private buildTrees(group: THREE.Group, list: number[]): { detail: THREE.Object3D[]; all: THREE.Object3D[] } {
    const t = this.w.trees;
    const trees = list.filter((i) => t[i + 5] !== 2 && !this.felled.has(i));
    const N = this.w.size;
    const bushes = list.filter((i) => t[i + 5] === 2 && this.bushGrid[Math.floor(t[i + 1]) * N + Math.floor(t[i])]);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const c = new THREE.Color();
    const detail: THREE.Object3D[] = [];
    const all: THREE.Object3D[] = [];

    const make = (count: number, fill: (k: number) => void) => {
      const mesh = new THREE.InstancedMesh(boxGeo, treeMat, count);
      for (let k = 0; k < count; k++) {
        fill(k);
        mesh.setMatrixAt(k, m);
        mesh.setColorAt(k, c);
      }
      mesh.computeBoundingSphere();
      group.add(mesh);
      all.push(mesh);
      return mesh;
    };

    if (trees.length) {
      const canopy = make(trees.length, (k) => {
        const i = trees[k];
        const big = t[i + 4] === 5;
        const ch = big ? 3 : 2;
        p.set(t[i], t[i + 2] + t[i + 3], t[i + 1]);
        s.set(t[i + 4], ch, t[i + 4]);
        m.compose(p, q, s);
        const v = (hash(i) - 0.5) * 0.18;
        if (t[i + 5] === 1) c.setRGB(0.2 + v, 0.42 + v, 0.18 + v * 0.5);
        else c.setRGB(0.3 + v, 0.55 + v, 0.24 + v * 0.5);
      });
      const trunks = make(trees.length, (k) => {
        const i = trees[k];
        p.set(t[i], t[i + 2], t[i + 1]);
        s.set(0.4, t[i + 3] + 0.2, 0.4);
        m.compose(p, q, s);
        c.setRGB(0.42, 0.29, 0.17);
      });
      detail.push(trunks);
      trees.forEach((i, k) => this.treeInst.set(i, [{ mesh: canopy, k }, { mesh: trunks, k }]));
    }
    if (bushes.length) {
      const bm = make(bushes.length, (k) => {
        const i = bushes[k];
        p.set(t[i], t[i + 2], t[i + 1]);
        s.set(0.9, 0.5, 0.9);
        m.compose(p, q, s);
        const v = (hash(i) - 0.5) * 0.12;
        c.setRGB(0.24 + v, 0.46 + v, 0.2);
      });
      bushes.forEach((i, k) => this.bushInst.set(Math.floor(t[i + 1]) * N + Math.floor(t[i]), { mesh: bm, k }));
      detail.push(bm);
    }
    return { detail, all };
  }
}

function hash(i: number) {
  let h = Math.imul(i, 2654435761);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Greedy-meshed terrain and water for one chunk. */
export function buildTerrain(w: WorldData, cx: number, cz: number) {
  const N = w.size;
  const x0 = cx * CHUNK;
  const z0 = cz * CHUNK;
  const sx = Math.min(CHUNK, N - x0);
  const sz = Math.min(CHUNK, N - z0);
  const H = w.height;
  const S = w.surface;
  const g = new GeoBuilder();
  const hAt = (x: number, z: number) => (x < 0 || z < 0 || x >= N || z >= N ? 0 : H[z * N + x]);

  // ---- top faces: merge rectangles with equal height and surface
  const visited = new Uint8Array(sx * sz);
  const key = (lx: number, lz: number) => {
    const i = (z0 + lz) * N + x0 + lx;
    return H[i] * 8 + S[i];
  };
  for (let lz = 0; lz < sz; lz++) {
    for (let lx = 0; lx < sx; lx++) {
      if (visited[lz * sx + lx]) continue;
      const k = key(lx, lz);
      let wdt = 1;
      while (lx + wdt < sx && !visited[lz * sx + lx + wdt] && key(lx + wdt, lz) === k) wdt++;
      let hgt = 1;
      outer: while (lz + hgt < sz) {
        for (let u = 0; u < wdt; u++) {
          if (visited[(lz + hgt) * sx + lx + u] || key(lx + u, lz + hgt) !== k) break outer;
        }
        hgt++;
      }
      for (let v = 0; v < hgt; v++) for (let u = 0; u < wdt; u++) visited[(lz + v) * sx + lx + u] = 1;
      const y = Math.floor(k / 8);
      const base = TOP[k & 7];
      const tint = y & 1 ? 0.95 : 1;
      const col = [base[0] * tint, base[1] * tint, base[2] * tint];
      const ax = x0 + lx, az = z0 + lz, bx = ax + wdt, bz = az + hgt;
      g.quad(ax, y, az, ax, y, bz, bx, y, bz, bx, y, az, col);
    }
  }

  // ---- side faces: for each direction, merge runs with equal (top, bottom, surface)
  const DIRS: [number, number, number][] = [[1, 0, 2], [-1, 0, 3], [0, 1, 4], [0, -1, 5]];
  for (const [dx, dz, face] of DIRS) {
    const alongX = dz !== 0; // faces facing ±z run along x
    const outerN = alongX ? sz : sx;
    const innerN = alongX ? sx : sz;
    for (let o = 0; o < outerN; o++) {
      let run = -1;
      let runKey = -1;
      let runTop = 0, runBot = 0, runSurf = 0;
      const flush = (end: number) => {
        if (run < 0) return;
        emitSide(g, dx, dz, face, alongX, o, run, end, runTop, runBot, runSurf, x0, z0);
        run = -1;
      };
      for (let inr = 0; inr < innerN; inr++) {
        const lx = alongX ? inr : o;
        const lz = alongX ? o : inr;
        const wx = x0 + lx, wz = z0 + lz;
        const h = H[wz * N + wx];
        const nh = hAt(wx + dx, wz + dz);
        if (nh >= h) { flush(inr); continue; }
        const surf = S[wz * N + wx];
        const k = (h * 1024 + nh) * 8 + surf;
        if (run >= 0 && k !== runKey) flush(inr);
        if (run < 0) { run = inr; runKey = k; runTop = h; runBot = nh; runSurf = surf; }
      }
      flush(innerN);
    }
  }

  // ---- deck planks (bridges and fords)
  for (let lz = 0; lz < sz; lz++) {
    for (let lx = 0; lx < sx; lx++) {
      const i = (z0 + lz) * N + x0 + lx;
      const d = w.deck[i];
      if (d < 0) continue;
      const x = x0 + lx, z = z0 + lz;
      g.box(x, d - 0.25, z, x + 1, d + 0.02, z + 1, PLANK);
    }
  }

  // ---- water surface (greedy by level), plus small falls where the level steps down
  const wb = new GeoBuilder();
  const W = w.water;
  visited.fill(0);
  const wkey = (lx: number, lz: number) => W[(z0 + lz) * N + x0 + lx];
  const wTop = [1, 1, 1];
  for (let lz = 0; lz < sz; lz++) {
    for (let lx = 0; lx < sx; lx++) {
      const k = wkey(lx, lz);
      if (k < 0 || visited[lz * sx + lx]) continue;
      let wdt = 1;
      while (lx + wdt < sx && !visited[lz * sx + lx + wdt] && wkey(lx + wdt, lz) === k) wdt++;
      let hgt = 1;
      outer2: while (lz + hgt < sz) {
        for (let u = 0; u < wdt; u++) {
          if (visited[(lz + hgt) * sx + lx + u] || wkey(lx + u, lz + hgt) !== k) break outer2;
        }
        hgt++;
      }
      for (let v = 0; v < hgt; v++) for (let u = 0; u < wdt; u++) visited[(lz + v) * sx + lx + u] = 1;
      const y = k - 0.12;
      const ax = x0 + lx, az = z0 + lz, bx = ax + wdt, bz = az + hgt;
      wb.quad(ax, y, az, ax, y, bz, bx, y, bz, bx, y, az, wTop);
      // falls toward lower water in the 4 neighbours of this rectangle are rare; draw per cell
      for (let v = 0; v < hgt; v++) {
        for (let u = 0; u < wdt; u++) {
          const x = ax + u, z = az + v;
          for (const [ddx, ddz, face] of DIRS) {
            const nx = x + ddx, nz = z + ddz;
            if (nx < 0 || nz < 0 || nx >= N || nz >= N) continue;
            const nw = W[nz * N + nx];
            if (nw < 0 || nw >= k) continue;
            emitSide(wb, ddx, ddz, face, ddz !== 0, ddz !== 0 ? z - z0 : x - x0, ddz !== 0 ? x - x0 : z - z0,
              (ddz !== 0 ? x - x0 : z - z0) + 1, k - 0.12, nw - 0.12, -1, x0, z0);
          }
        }
      }
    }
  }

  return { terrain: g.build(), water: wb.empty ? null : wb.build() };
}

function emitSide(
  g: GeoBuilder, dx: number, dz: number, face: number, alongX: boolean, o: number,
  start: number, end: number, top: number, bot: number, surf: number, x0: number, z0: number,
) {
  const shade = FACE_SHADE[face];
  let base: readonly number[];
  if (surf < 0) base = [1, 1, 1];
  else if (top - bot <= 2) {
    const t = TOP[surf];
    base = [t[0] * 0.85, t[1] * 0.85, t[2] * 0.85];
  } else base = SIDE[surf];
  const c = [base[0] * shade, base[1] * shade, base[2] * shade];
  const cb = [c[0] * 0.72, c[1] * 0.72, c[2] * 0.72];
  const y0 = bot, y1 = top;
  if (alongX) {
    const z = z0 + o + (dz > 0 ? 1 : 0);
    const xa = x0 + start, xb = x0 + end;
    if (dz > 0) g.quad(xb, y0, z, xb, y1, z, xa, y1, z, xa, y0, z, c, cb, 9);
    else g.quad(xa, y0, z, xa, y1, z, xb, y1, z, xb, y0, z, c, cb, 9);
  } else {
    const x = x0 + o + (dx > 0 ? 1 : 0);
    const za = z0 + start, zb = z0 + end;
    if (dx > 0) g.quad(x, y0, za, x, y1, za, x, y1, zb, x, y0, zb, c, cb, 9);
    else g.quad(x, y0, zb, x, y1, zb, x, y1, za, x, y0, za, c, cb, 9);
  }
}
