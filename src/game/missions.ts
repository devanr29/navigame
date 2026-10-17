// Field missions for levels 2–6 (GDD "Progression and levels"). Each mission sets up the world, lists
// objectives that tick off from what the player actually does, offers context actions, and produces a
// debrief. Level 1 (base camp) is the packing screen and map quiz only (see screens.ts).
import * as THREE from 'three';
import { BLOCK_M, Zone, type Landmark, type WorldData } from '../gen/constants';
import { fmtDMS, latSecAt, lonSecAt } from '../map/geo';
import type { MapView } from '../map/mapView';
import type { Player } from '../player/player';
import { angleDiff, azimuthTo, backAzimuth, gridOf, magneticOf, setDeclination, smokeTarget, type Sight } from '../tools/sight';
import type { Notebook } from '../ui/notebook';
import { flagPost, smokeColumn, targetPost } from '../world/objects3d';
import type { PaceCounter } from './pace';
import { DEFAULT_PACE } from './pace';
import type { P, Sites } from './sites';
import { SMOKE_TARGET, type MapLine, type Progress, type Reading, type ToolId } from './state';
import type { Team } from './team';

export interface Objective { text: string; done: boolean; optional?: boolean }
export interface Action { id: string; label: string; run: () => void; hold?: (down: boolean) => void; primary?: boolean }
export interface Result {
  passed: boolean;
  score: number;
  stats: [string, string][];
  lessons: string[];
}

export interface Ctx {
  w: WorldData;
  sites: Sites;
  sight: Sight;
  player: Player;
  map: MapView;
  notebook: Notebook;
  team: Team;
  pace: PaceCounter;
  scene: THREE.Scene;
  tools: Set<ToolId>;
  progress: Progress;
  saveProgress(): void;
  toast(title: string, lines?: string[]): void;
  /** Opens the map in "mark a point" mode; resolves with the point or null if cancelled/impossible. */
  askMark(prompt: string): Promise<P | null>;
  /** Asks for numbers in a small dialog. */
  askNumbers(title: string, fields: { key: string; label: string; value?: number }[]): Promise<Record<string, number> | null>;
  /** Locks the compass (tape marker and team gauge). */
  lockCompass(az: number | null): void;
  /** Puts back every tree the penerabas felled and every bush cut (a fresh forest). */
  restoreVegetation(): void;
  /** Moves the player to another site mid-mission (not walking: the pace counter ignores the jump). */
  relocate(x: number, z: number, faceAz: number): void;
}

const M = (blocks: number) => Math.round(blocks * BLOCK_M);
const dist = (a: P, b: P) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const deg = (a: number) => `${String(Math.round(a)).padStart(3, '0')}°`;
const here = (c: Ctx): P => [c.player.x, c.player.z];

/** Unit direction (sheet coordinates) of a map line's azimuth. */
const rayDir = (l: MapLine): P => [Math.sin((l.az * Math.PI) / 180), -Math.cos((l.az * Math.PI) / 180)];

/** Distance from a point to a drawn line (a ray from its origin). */
function rayMiss(l: MapLine, p: P): number {
  const [dx, dz] = rayDir(l);
  const vx = p[0] - l.x, vz = p[1] - l.z;
  return vx * dx + vz * dz < 0 ? Math.hypot(vx, vz) : Math.abs(vx * dz - vz * dx);
}

/** Crossing point of two drawn lines (extended both ways), or null if they are nearly parallel. */
function rayCross(a: MapLine, b: MapLine): P | null {
  const [ax, az] = rayDir(a), [bx, bz] = rayDir(b);
  const den = ax * bz - az * bx;
  if (Math.abs(den) < 1e-6) return null;
  const t = ((b.x - a.x) * bz - (b.z - a.z) * bx) / den;
  return [a.x + ax * t, a.z + az * t];
}

/** Coordinates in the material's format: latitude first, then longitude (minutes′seconds″). */
export function fmtCoord(p: P): string {
  return `${fmtDMS(latSecAt(p[1]), false)} LS, ${fmtDMS(lonSecAt(p[0]), false)} BT`;
}

export interface LevelInfo {
  n: number;
  title: string;
  focus: string;
  mechanic: string;
  pass: string;
}

export const LEVELS: LevelInfo[] = [
  { n: 1, title: 'Base camp', focus: 'Persiapan', mechanic: 'Mengemas alat, koordinat, skala, kontur, karvak', pass: 'Semua soal peta benar' },
  { n: 2, title: 'Orientasi & Resection', focus: 'Utarakan peta, orientasi medan, mencari posisi sendiri', mechanic: 'Memutar peta, memasangkan titik ekstrem, back azimuth, menggaris', pass: 'Peta terutarakan; galat posisi di bawah 100 m' },
  { n: 3, title: 'Intersection', focus: 'Mencari letak objek', mechanic: 'Azimut dari dua titik diketahui', pass: 'Objek ditemukan dalam 150 m' },
  { n: 4, title: 'Rute navigasi terbuka', focus: 'Jalur dan persimpangan', mechanic: 'Rencana jalur, cek di setiap persimpangan', pass: 'Sampai tujuan; semua persimpangan dicek' },
  { n: 5, title: 'Navigasi tertutup: ke puncak', focus: 'Dari ujung jalan setapak menembus hutan ke puncak yang tidak terlihat', mechanic: 'Resection, kunci kompas, maju dengan jumlah langkah, penerabas dan sweeper', pass: 'Sampai di puncak; galat resection di bawah 100 m' },
  { n: 6, title: 'Misi akhir', focus: 'Navigasi terbuka lalu navigasi tertutup', mechanic: 'Alur lengkap dengan skor akhir', pass: 'Alur lengkap selesai' },
];

export abstract class Mission {
  objectives: Objective[] = [];
  result: Result | null = null;
  time = 0;
  /** Briefing paragraphs. */
  briefing: string[] = [];
  /** Point the player must mark on the map before leaving (Phase A step 3), with its coordinates in the briefing. */
  destination: { p: P; label: string } | null = null;
  destinationTries = 0;
  /** Show "map is off by X°" while the map is open. */
  orientCheck = false;
  /** Show the pace counter in the HUD. */
  showPace = false;
  /** The player cannot walk (may still look around); the team moves them. */
  holdPlayer = false;
  declination = 0;
  /** Time (s) a confident player needs; slower costs time points. */
  par = 300;
  /**
   * Weather: 0 = clear day (terrain readable far away), 1 = hazy (distant hills fade early). Early
   * levels are clear so beginners can read the terrain; later levels get hazier, as often in the field.
   */
  haze: number;
  protected objects: THREE.Object3D[] = [];
  protected lessons: string[] = [];

  constructor(protected c: Ctx, readonly level: number) {
    this.haze = level <= 3 ? 0 : level === 4 ? 0.35 : 0.6;
  }

  abstract start(): void;
  update(_dt: number) {}
  onReading(_r: Reading) {}
  onMapOpen() {}
  onMapClose() {}
  actions(): Action[] { return []; }

  /**
   * Developer mode only (/developer): the mission's internal state and the answers it checks against,
   * so a tester can see why an objective did or did not tick and how the debrief will be scored.
   */
  devInfo(): [string, string][] { return []; }
  /** Developer mode only: named points of this mission to teleport to. */
  devPoints(): { label: string; p: P }[] { return []; }
  /**
   * Developer mode only: the steps that solve this mission, filled in with this world's answers
   * (azimuths, coordinates, distances). Shown collapsed in the panel.
   */
  devSolution(): string[] { return []; }

  /** Solution steps for a resection standing at p: the visible titik ekstrem pair crossing nearest 90°, then a third to check. */
  protected resectionKey(p: P): string[] {
    const { w, sight } = this.c;
    const N = w.size;
    const eye = w.height[Math.floor(p[1]) * N + Math.floor(p[0])] + 1.7 / BLOCK_M;
    const ids = sight.visibleLandmarks(p[0], eye, p[1], 420);
    const az = (id: number) => magneticOf(azimuthTo(p[0], p[1], w.landmarks[id].x, w.landmarks[id].z));
    const quality = (a: number, b: number) => 90 - Math.abs(90 - Math.abs(angleDiff(az(a), az(b))));
    let pair: [number, number] | null = null;
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      if (!pair || quality(ids[i], ids[j]) > quality(...pair)) pair = [ids[i], ids[j]];
    }
    if (!pair) return [`Kurang dari dua titik ekstrem terlihat dari ${fmtCoord(p)}. Pindah sedikit ke tempat yang lebih terbuka.`];
    const step = (id: number) => {
      const a = Math.round(az(id)) % 360;
      return `Bidik ${w.landmarks[id].name}: azimut ${deg(a)}. Di Catatan pasangkan dengan simbol ${w.landmarks[id].name}, back azimuth ${deg(backAzimuth(a))}. Di peta letakkan busur di simbol itu dan gariskan ${deg(backAzimuth(a))}.`;
    };
    const third = ids.find((id) => !pair.includes(id));
    return [
      ...pair.map(step),
      ...(third === undefined ? [] : [`Opsional, cek dengan titik ketiga: ${step(third)}`]),
      `Garis-garis berpotongan di ${fmtCoord(p)} (selisih arah ${Math.round(quality(...pair))}°).`,
    ];
  }

  /** Removes the mission's objects from the world. */
  cleanup() {
    for (const o of this.objects) this.c.scene.remove(o);
    this.objects = [];
    this.c.sight.extra = [];
    setDeclination(0);
    this.c.map.declinationLabel = 'Deklinasi magnetis: 0°';
  }

  protected place(obj: THREE.Object3D, p: P, yOffset = 0) {
    const N = this.c.w.size;
    const i = Math.floor(p[1]) * N + Math.floor(p[0]);
    obj.position.set(p[0], this.c.w.height[i] + yOffset, p[1]);
    this.c.scene.add(obj);
    this.objects.push(obj);
    return obj;
  }

  protected allDone() {
    return this.objectives.every((o) => o.done || o.optional);
  }

  protected timeScore(maxPts: number) {
    return maxPts * clamp01(1 - Math.max(0, this.time - this.par) / (this.par * 2));
  }

  /** Mean error (degrees) of readings that hit something, against the true bearing from where they were taken. */
  protected azimuthError(): number | null {
    const errs: number[] = [];
    for (const r of this.c.notebook.readings) {
      if (r.target < 0) continue;
      const t = this.c.sight.target(r.target);
      if (!t) continue;
      errs.push(Math.abs(angleDiff(r.azimuth, magneticOf(azimuthTo(r.x, r.z, t.x, t.z)))));
    }
    return errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : null;
  }

  protected azScore(maxPts: number) {
    const e = this.azimuthError();
    return e === null ? maxPts * 0.5 : maxPts * clamp01(1 - (e - 1) / 6);
  }

  protected finish(passed: boolean, score: number, stats: [string, string][]) {
    const e = this.azimuthError();
    if (e !== null) stats.push(['Rata-rata galat azimut', `${e.toFixed(1)}°`]);
    stats.push(['Waktu', `${Math.floor(this.time / 60)} menit ${Math.round(this.time % 60)} detik`]);
    const unsettled = this.c.notebook.readings.filter((r) => !r.settled).length;
    if (unsettled) this.lessons.push(`${unsettled} bidikan diambil saat jarum belum tenang. Tunggu jarum diam sebelum melepas tombol.`);
    this.result = { passed, score: Math.round(Math.max(0, Math.min(100, score))), stats, lessons: this.lessons };
  }

  /** Names a landmark/post for messages. */
  protected nameOf(id: number) {
    if (id === SMOKE_TARGET) return 'asap';
    return this.c.w.landmarks[id]?.name ?? this.c.map.symbols.find((s) => s.id === id)?.label ?? '?';
  }

  /** Number of distinct landmarks paired correctly / at all. */
  protected pairs() {
    const correct = new Set<number>(), any = new Set<number>();
    let wrong = 0;
    for (const r of this.c.notebook.readings) {
      if (r.pairedWith < 0) continue;
      any.add(r.pairedWith);
      if (r.pairedWith === r.target) correct.add(r.target);
      else wrong++;
    }
    return { correct: correct.size, any: any.size, wrong };
  }

  /** Lines on the map drawn from (near) a point, in sheet blocks. */
  protected linesFrom(p: P, r = 8) {
    return this.c.map.lines.filter((l) => Math.hypot(l.x - p[0], l.z - p[1]) <= r);
  }

  /** Lesson when the two paired readings cross at a narrow angle (weak fix). */
  protected crossingTip() {
    const ps = this.c.notebook.readings.filter((r) => r.pairedWith >= 0);
    if (ps.length < 2) return;
    const a = ps[ps.length - 1].azimuth, b = ps[ps.length - 2].azimuth;
    const ang = Math.abs(angleDiff(a, b));
    if (ang < 30 || ang > 150) {
      this.lessons.push(`Dua titik ekstrem yang dipakai hanya berselisih ${Math.round(ang)}°. Garis yang berpotongan dengan sudut sempit memberi posisi yang lemah; pilih titik yang selisih arahnya mendekati 90°.`);
    }
  }

  /** Checks the map's orientation while open (for orientCheck missions). */
  protected orientDone(): boolean {
    if (!this.c.map.isOpen() || this.c.map.orientFacing === null) return false;
    return Math.abs(this.c.map.orientationError(this.c.map.orientFacing)) <= 5;
  }

  /** Marks a position on the map and returns the error in blocks against where the player stands. */
  protected async markMyPosition(prompt = 'Tandai posisimu di peta (titik potong garis), lalu Kirim'): Promise<{ p: P; err: number } | null> {
    const p = await this.c.askMark(prompt);
    if (!p) return null;
    const truth: P = [this.c.player.x, this.c.player.z];
    this.c.map.marks.push({ x: p[0], z: p[1], label: 'Posisiku', pen: !this.c.tools.has('pensil') });
    return { p, err: dist(p, truth) };
  }

  protected revealTruth(p: P, mark: P | null, label: string) {
    this.c.map.reveals.push({ x: p[0], z: p[1], label, color: '#1d8a3a', from: mark ?? undefined });
    this.c.map.redraw();
  }
}

// ======================================================================= level 2: orientation and resection

class Resection extends Mission {
  start() {
    const { sites, player } = this.c;
    player.teleport(sites.resection[0], sites.resection[1], 125);
    this.orientCheck = true;
    this.par = 600;
    this.briefing = [
      'Kamu tidak tahu sedang berada di mana. Tentukan posisimu dengan resection: dari dua titik ekstrem yang terlihat dan sudah kamu kenali di peta.',
      'Orientasi medan: setiap titik ekstrem yang kamu bidik harus dipasangkan dengan simbolnya yang benar di peta. Pasangan yang salah membuat garis berangkat dari tempat yang salah, sehingga posisimu meleset.',
      '1. Utarakan peta: lihat derajat kompas di atas layar, buka peta, putar peta dengan dua jari sampai utaranya searah utara sebenarnya.',
      '2. Bidik titik ekstrem pertama dengan kompas. Di Catatan, pasangkan bidikan dengan simbolnya di peta dan tulis back azimuth-nya. Di peta, letakkan busur di simbol itu dan gariskan back azimuth-nya.',
      '3. Ulangi langkah 2 untuk titik ekstrem kedua.',
      '4. Cek dengan titik ekstrem ketiga bila terlihat. Dua garis selalu berpotongan, walau bidikannya meleset. Garis ketiga membentuk segitiga galat: makin kecil segitiganya, makin teliti bidikanmu.',
      '5. Tandai posisimu di peta, yaitu titik potong garis (di dalam segitiga galat), lalu kirim.',
    ];
    this.objectives = [
      { text: 'Utarakan peta', done: false },
      { text: 'Titik ekstrem 1: bidik, pasangkan, back azimuth, gariskan', done: false },
      { text: 'Titik ekstrem 2: bidik, pasangkan, back azimuth, gariskan', done: false },
      { text: 'Cek titik ekstrem 3 (segitiga galat)', done: false, optional: true },
      { text: 'Tandai posisimu di peta (perpotongan garis)', done: false },
    ];
  }

  update(dt: number) {
    if (this.result) return;
    this.time += dt;
    const o = this.objectives;
    if (this.orientDone()) o[0].done = true;
    // Steps per titik ekstrem, in the order the player paired them.
    const rs = this.c.notebook.readings;
    const symbols: number[] = [];
    for (const r of rs) if (r.pairedWith >= 0 && !symbols.includes(r.pairedWith)) symbols.push(r.pairedWith);
    const hits = rs.filter((r) => r.target >= 0).length;
    const tick = (b: boolean) => (b ? '✓' : '○');
    for (let k = 0; k < 3; k++) {
      const id = symbols[k];
      const l = id === undefined ? undefined : this.c.w.landmarks[id];
      const aimed = hits > k || id !== undefined;
      const paired = id !== undefined;
      const back = paired && rs.some((r) => r.pairedWith === id && r.backTyped !== null && Math.abs(r.backTyped - backAzimuth(r.azimuth)) < 0.5);
      const line = !!l && this.linesFrom([l.x, l.z]).length > 0;
      const name = k === 2 ? 'Cek titik ekstrem 3' : `Titik ekstrem ${k + 1}`;
      o[1 + k].text = `${name}${l ? ` (${l.name})` : ''}: bidik ${tick(aimed)} pasang ${tick(paired)} back az ${tick(back)} garis ${tick(line)}`;
      // Once a step is done it stays done: erasing a line to redraw it is normal map work.
      o[1 + k].done ||= aimed && paired && back && line;
    }
  }

  actions(): Action[] {
    return [{ id: 'mark', label: 'Tandai posisiku', primary: true, run: () => void this.submit() }];
  }

  private async submit() {
    const m = await this.markMyPosition();
    if (!m || this.result) return;
    this.objectives[4].done = true;
    const errM = M(m.err);
    const truth = here(this.c);
    const checks = this.lineChecks(truth);
    // The true line from each landmark through the real position, next to the player's own line.
    for (const k of checks) this.c.map.reveals.push({ x: truth[0], z: truth[1], from: [k.l.x, k.l.z], label: '', color: '#1d8a3a', dot: false });
    this.revealTruth(truth, m.p, `Posisi sebenarnya (galat ${errM} m)`);
    this.crossingTip();
    if (!this.objectives[0].done) this.lessons.push('Peta belum diutarakan. Utarakan peta dulu, supaya arah di peta sama dengan arah di medan dan titik ekstrem mudah dikenali.');
    const p = this.pairs();
    if (p.wrong) this.lessons.push('Ada bidikan yang dipasangkan dengan simbol yang salah, sehingga garisnya berangkat dari tempat yang salah.');
    this.sightingLessons(checks);
    const tri = this.errorTriangle(checks);
    if (tri !== null) {
      this.lessons.push(tri <= 40
        ? `Tiga garismu membentuk segitiga galat kecil (sisi terpanjang ${tri} m): ketiga bidikan saling menguatkan, dan posisimu ada di dalam atau dekat segitiga itu.`
        : `Tiga garismu membentuk segitiga galat besar (sisi terpanjang ${tri} m): ada bidikan yang meleset. Di lapangan, bidik ulang titik ekstrem yang garisnya paling jauh dari dua garis lainnya.`);
    } else {
      this.lessons.push('Bila ada titik ekstrem ketiga yang terlihat, pakai untuk mengecek. Dua garis selalu berpotongan, jadi bidikan yang meleset tidak kelihatan. Tiga garis membentuk segitiga galat yang menunjukkan seberapa teliti bidikanmu.');
    }
    this.lessons.push('Resection = mencari posisi diri sendiri, memakai BACK AZIMUTH dari titik ekstrem yang diketahui.');
    const passed = errM <= 100;
    const stats: [string, string][] = [
      ['Galat posisi', `${errM} m`],
      ['Batas lulus', '100 m'],
    ];
    for (const k of checks) {
      const line = k.missM === null ? 'belum digaris' : `garismu lewat ${k.missM} m dari posisimu`;
      stats.push([`Garis ${k.l.name}`, `bidikan ${deg(k.r.azimuth)}, benar ${deg(k.trueAz)}: meleset ${k.errDeg.toFixed(1)}° ≈ ${k.shiftM} m pada jarak ${k.distM} m; ${line}`]);
    }
    stats.push(['Segitiga galat', tri === null ? 'tidak dicek (perlu 3 garis)' : `sisi terpanjang ${tri} m`]);
    this.finish(passed, 60 * clamp01(1 - errM / 150) + this.azScore(25) + this.timeScore(15), stats);
  }

  /**
   * Per correctly paired landmark (in pairing order): the sighting error, how far that error shifts the
   * line at the player's distance, and how far the player's drawn line actually passes from the truth.
   */
  private lineChecks(truth: P) {
    const out: { l: Landmark; r: Reading; line: MapLine | null; trueAz: number; errDeg: number; distM: number; shiftM: number; missM: number | null }[] = [];
    const seen = new Set<number>();
    for (const r of this.c.notebook.readings) {
      if (r.pairedWith < 0 || r.pairedWith !== r.target || seen.has(r.pairedWith)) continue;
      seen.add(r.pairedWith);
      // the latest reading of this landmark counts (the player may have re-sighted it)
      const last = [...this.c.notebook.readings].reverse().find((q) => q.pairedWith === r.pairedWith && q.target === r.pairedWith)!;
      const l = this.c.w.landmarks[r.pairedWith];
      const lines = this.linesFrom([l.x, l.z]);
      const line = lines.length ? lines[lines.length - 1] : null;
      const trueAz = magneticOf(azimuthTo(last.x, last.z, l.x, l.z));
      const errDeg = Math.abs(angleDiff(last.azimuth, trueAz));
      const d = dist([last.x, last.z], [l.x, l.z]);
      out.push({ l, r: last, line, trueAz, errDeg, distM: M(d), shiftM: M(d * Math.sin((errDeg * Math.PI) / 180)), missM: line ? M(rayMiss(line, truth)) : null });
    }
    return out;
  }

  /** Makes the cost of a few degrees visible: worst sighting error in metres, or a drawing problem. */
  private sightingLessons(checks: ReturnType<Resection['lineChecks']>) {
    if (!checks.length) return;
    const worst = checks.reduce((a, b) => (b.shiftM > a.shiftM ? b : a));
    if (worst.errDeg >= 1) {
      this.lessons.push(`Bidikan ke ${worst.l.name} meleset ${worst.errDeg.toFixed(1)}°. Pada jarak ${worst.distM} m, selisih sekecil itu menggeser garis sekitar ${worst.shiftM} m. Aturan praktis: galat 1° ≈ 17 m untuk setiap 1 km jarak, jadi makin jauh titik ekstrem, makin teliti bidikan harus.`);
    } else {
      this.lessons.push('Semua bidikanmu teliti (galat di bawah 1°). Ingat: galat 1° saja menggeser garis sekitar 17 m untuk setiap 1 km jarak ke titik ekstrem.');
    }
    const drawn = checks.find((k) => k.missM !== null && k.missM > k.shiftM + 25);
    if (drawn) this.lessons.push(`Garis dari ${drawn.l.name} lewat ${drawn.missM} m dari posisimu, lebih jauh dari yang disebabkan bidikannya. Periksa back azimuth dan cara meletakkan busur saat menggaris.`);
  }

  /** Longest side (m) of the triangle formed by the first three drawn lines, or null if fewer than three. */
  private errorTriangle(checks: ReturnType<Resection['lineChecks']>): number | null {
    const ls = checks.map((k) => k.line).filter((l): l is MapLine => l !== null).slice(0, 3);
    if (ls.length < 3) return null;
    const a = rayCross(ls[0], ls[1]), b = rayCross(ls[1], ls[2]), c = rayCross(ls[2], ls[0]);
    if (!a || !b || !c) return null;
    return M(Math.max(dist(a, b), dist(b, c), dist(c, a)));
  }

  devInfo(): [string, string][] {
    const out: [string, string][] = [];
    this.c.notebook.readings.forEach((r, k) => {
      if (r.pairedWith < 0) return;
      const l = this.c.w.landmarks[r.pairedWith];
      const ok = r.pairedWith === r.target ? 'pasangan benar' : `SALAH (terbidik: ${r.target < 0 ? 'tidak ada' : this.nameOf(r.target)})`;
      out.push([`#${k + 1} → ${this.nameOf(r.pairedWith)}`,
        `${ok} · back az ${deg(backAzimuth(r.azimuth))} · ditulis ${r.backTyped === null ? '—' : deg(r.backTyped)} · garis ${l ? this.linesFrom([l.x, l.z]).length : 0}`]);
    });
    return out;
  }

  devPoints() { return [{ label: 'Titik resection', p: this.c.sites.resection }]; }

  devSolution() {
    const p = this.c.sites.resection;
    return [
      'Utarakan peta (selisih ≤5°).',
      ...this.resectionKey(p),
      `Tekan Tandai posisiku dan ketuk titik potong di ${fmtCoord(p)}. Lulus bila galat ≤100 m.`,
    ];
  }
}

// ======================================================================= level 3: intersection

class Intersection extends Mission {
  private A!: P;
  private B!: P;
  private smoke!: P;
  private fx: { update(t: number): void } | null = null;
  private readings: { a: number | null; b: number | null } = { a: null, b: null };

  start() {
    const { sites, player, w } = this.c;
    ({ a: this.A, b: this.B, smoke: this.smoke } = sites.intersection);
    const N = w.size;
    const sy = w.height[Math.floor(this.smoke[1]) * N + Math.floor(this.smoke[0])];
    player.teleport(this.A[0] + 1.5, this.A[1] + 1.5, azimuthTo(this.A[0], this.A[1], this.smoke[0], this.smoke[1]) - 60);
    this.place(flagPost(0xf08a1c), this.A);
    this.place(flagPost(0x8a3cc8), this.B);
    const s = smokeColumn();
    this.fx = s;
    this.place(s.group, this.smoke);
    this.c.sight.extra = [smokeTarget(this.smoke[0], sy, this.smoke[1], SMOKE_TARGET)];
    this.c.map.symbols = [
      { x: this.A[0], z: this.A[1], label: 'Pos A', id: 201 },
      { x: this.B[0], z: this.B[1], label: 'Pos B', id: 202 },
    ];
    this.par = 720;
    this.briefing = [
      'Ada asap kebakaran terlihat dari lapangan. Tentukan letaknya dengan intersection.',
      `Pos A (bendera oranye) di ${fmtCoord(this.A)}. Pos B (bendera ungu) di ${fmtCoord(this.B)}. Keduanya tergambar di peta.`,
      'Dari Pos A bidik asap dan gariskan AZIMUT itu (bukan back azimuth) dari Pos A. Berjalan ke Pos B dan ulangi. Titik potongnya adalah letak asap.',
    ];
    this.objectives = [
      { text: 'Bidik asap dari Pos A', done: false },
      { text: 'Gariskan azimut dari simbol Pos A', done: false },
      { text: 'Berjalan ke Pos B dan bidik asap', done: false },
      { text: 'Gariskan azimut dari simbol Pos B', done: false },
      { text: 'Tandai dan laporkan letak asap', done: false },
    ];
  }

  onReading(r: Reading) {
    if (r.target !== SMOKE_TARGET) return;
    if (dist([r.x, r.z], this.A) <= 8) { this.readings.a = r.azimuth; this.objectives[0].done = true; }
    if (dist([r.x, r.z], this.B) <= 8) { this.readings.b = r.azimuth; this.objectives[2].done = true; }
  }

  update(dt: number) {
    this.fx?.update(this.time);
    if (this.result) return;
    this.time += dt;
    // Once drawn, the step stays done: erasing a line to redraw it is normal map work.
    this.objectives[1].done ||= this.linesFrom(this.A).length > 0;
    this.objectives[3].done ||= this.linesFrom(this.B).length > 0;
  }

  actions(): Action[] {
    return [{ id: 'report', label: 'Laporkan letak asap', primary: true, run: () => void this.submit() }];
  }

  private async submit() {
    const p = await this.c.askMark('Tandai letak asap (titik potong kedua garis), lalu Kirim');
    if (!p || this.result) return;
    this.objectives[4].done = true;
    this.c.map.marks.push({ x: p[0], z: p[1], label: 'Asap?', pen: !this.c.tools.has('pensil') });
    const errM = M(dist(p, this.smoke));
    this.revealTruth(this.smoke, p, `Letak asap (galat ${errM} m)`);
    // Did they draw back azimuths by mistake?
    for (const [post, az] of [[this.A, this.readings.a], [this.B, this.readings.b]] as [P, number | null][]) {
      if (az === null) continue;
      if (this.linesFrom(post).some((l) => Math.abs(angleDiff(l.az, backAzimuth(az))) < 3)) {
        this.lessons.push('Ada garis yang memakai back azimuth. Pada intersection, garis ditarik dari titik pengamatan memakai AZIMUT ke objek.');
        break;
      }
    }
    this.lessons.push('Resection = mencari diri sendiri (back azimuth dari titik ekstrem). Intersection = mencari objek (azimut dari dua titik diketahui).');
    this.finish(errM <= 150, 60 * clamp01(1 - errM / 220) + this.azScore(25) + this.timeScore(15), [
      ['Galat letak asap', `${errM} m`],
      ['Batas lulus', '150 m'],
    ]);
  }

  devInfo(): [string, string][] {
    const s = this.smoke;
    const az = (p: P) => magneticOf(azimuthTo(p[0], p[1], s[0], s[1]));
    const lines = (p: P) => this.linesFrom(p).map((l) => deg(l.az)).join(', ') || '—';
    return [
      ['Azimut benar A → asap', `${deg(az(this.A))} (bidikan ${this.readings.a === null ? '—' : deg(this.readings.a)})`],
      ['Azimut benar B → asap', `${deg(az(this.B))} (bidikan ${this.readings.b === null ? '—' : deg(this.readings.b)})`],
      ['Garis dari A / B', `${lines(this.A)} / ${lines(this.B)}`],
      ['Jarak ke A / B', `${M(dist(here(this.c), this.A))} m / ${M(dist(here(this.c), this.B))} m (bidikan dihitung ≤20 m)`],
      ['Jarak A–asap / B–asap', `${M(dist(this.A, s))} m / ${M(dist(this.B, s))} m`],
    ];
  }

  devPoints() { return [{ label: 'Pos A', p: this.A }, { label: 'Pos B', p: this.B }, { label: 'Asap', p: this.smoke }]; }

  devSolution() {
    const s = this.smoke, A = this.A, B = this.B;
    const az = (p: P, q: P) => deg(magneticOf(azimuthTo(p[0], p[1], q[0], q[1])));
    return [
      `Di Pos A (≤20 m dari bendera oranye), bidik asap: azimut ${az(A, s)}.`,
      `Di peta letakkan busur di simbol Pos A dan gariskan ${az(A, s)} (azimut, bukan back azimuth).`,
      `Berjalan ke Pos B (bendera ungu): azimut ${az(A, B)}, ${M(dist(A, B))} m dari Pos A.`,
      `Di Pos B bidik asap: azimut ${az(B, s)}. Gariskan ${az(B, s)} dari simbol Pos B.`,
      `Tekan Laporkan letak asap dan ketuk titik potong di ${fmtCoord(s)}. Lulus bila galat ≤150 m.`,
    ];
  }
}

// ======================================================================= level 4: navter route

class Route extends Mission {
  /** Per crossroad: blocks between the player's junction mark and the real junction, null = not checked. */
  private checked: (number | null)[] = [];
  private announced: boolean[] = [];
  private startErr: number | null = null;
  /** "Lapor tiba" pressed away from the post. */
  private falseReports = 0;
  /** A mark within this many blocks (25 m) identifies the junction; junctions are 100+ blocks apart. */
  private static readonly JUNCTION_OK = 10;

  start() {
    const { sites, player } = this.c;
    const r = sites.route;
    const j = r.crossroads[0];
    player.teleport(r.start[0], r.start[1], azimuthTo(r.start[0], r.start[1], j[0], j[1]));
    this.place(targetPost(), r.dest);
    this.destination = { p: r.dest, label: 'Tujuan' };
    this.orientCheck = true;
    this.showPace = true;
    this.par = 900;
    this.checked = r.crossroads.map(() => null);
    this.announced = r.crossroads.map(() => false);
    this.briefing = [
      `Tujuanmu pos bendera oranye di ${fmtCoord(r.dest)}, di tepi jalan. Tandai di peta sebelum berangkat.`,
      'Mulailah dengan resection untuk memastikan posisi awal. Rencanakan jalur lewat jalan (garis ganda kuning di peta) dan jalan setapak, lalu catat persimpangan yang akan dilewati dan jarak antar persimpangan.',
      'Persimpangan sudah ada di peta, jadi tidak perlu resection di sana. Cocokkan dengan peta: hitung cabangnya dan bidik arah cabang, lalu tekan Cek persimpangan dan tandai di peta persimpangan yang mana. Salah mengenali persimpangan berarti salah cabang.',
      `Dari persimpangan terakhir, ukur jarak ke pos di peta, lalu hitung langkah (sekitar ${DEFAULT_PACE} langkah per 100 m). Hitungan langkah dimulai ulang setiap kali persimpangan dicek. Tekan Lapor tiba saat sampai di pos.`,
    ];
    this.objectives = [
      { text: 'Utarakan peta', done: false },
      { text: 'Resection di titik awal (Tandai posisiku)', done: false },
      { text: 'Rencanakan jalur dengan pensil', done: false, optional: true },
      ...r.crossroads.map((_, k) => ({ text: `Cek persimpangan ${k + 1} (cocokkan dengan peta)`, done: false })),
      { text: 'Lapor tiba di pos tujuan', done: false },
    ];
  }

  update(dt: number) {
    if (this.result) return;
    this.time += dt;
    const { player, sites } = this.c;
    const o = this.objectives;
    if (this.orientDone()) o[0].done = true;
    if (this.c.map.strokes.length) o[2].done = true;
    sites.route.crossroads.forEach((j, k) => {
      if (!this.announced[k] && dist([player.x, player.z], j) < 12) {
        this.announced[k] = true;
        this.c.toast('Persimpangan!', ['Berhenti. Hitung cabangnya, bidik arah cabang, lalu Cek persimpangan sebelum memilih cabang.']);
      }
    });
  }

  actions(): Action[] {
    return [
      { id: 'mark', label: 'Tandai posisiku', run: () => void this.resect() },
      { id: 'junction', label: 'Cek persimpangan', run: () => void this.checkJunction() },
      { id: 'arrive', label: 'Lapor tiba', primary: true, run: () => this.arrive() },
    ];
  }

  private async resect() {
    const m = await this.markMyPosition('Tandai posisimu dari hasil resection, lalu Kirim');
    if (!m || this.result) return;
    if (dist(here(this.c), this.c.sites.route.start) < 25 && !this.objectives[1].done) {
      this.objectives[1].done = true;
      this.startErr = M(m.err);
      this.c.notebook.notes.push('Resection awal ditandai.');
    }
  }

  /** At a junction the player marks which junction on the map it is; no resection needed on a known feature. */
  private async checkJunction() {
    const h = here(this.c), js = this.c.sites.route.crossroads;
    let k = -1;
    js.forEach((j, i) => { if (dist(h, j) < 15 && (k < 0 || dist(h, j) < dist(h, js[k]))) k = i; });
    if (k < 0) {
      this.c.toast('Belum di persimpangan', ['Cek persimpangan dilakukan saat berdiri di persimpangan jalan.']);
      return;
    }
    const p = await this.c.askMark('Tandai di peta persimpangan tempatmu berdiri, lalu Kirim');
    if (!p || this.result) return;
    this.c.map.marks.push({ x: p[0], z: p[1], label: 'Persimpangan', pen: !this.c.tools.has('pensil') });
    this.checked[k] = dist(p, js[k]);
    this.objectives[3 + k].done = true;
    this.c.pace.reset();
    this.c.notebook.notes.push(`Persimpangan dicek di ${fmtCoord(p)}. Hitungan langkah mulai dari sini.`);
    this.c.toast('Persimpangan dicek', ['Hitungan langkah dimulai ulang. Pilih cabang sesuai rencana jalur.']);
  }

  private arrive() {
    if (this.result) return;
    const r = this.c.sites.route;
    if (dist(here(this.c), r.dest) > 8) {
      this.falseReports++;
      this.c.toast('Pos tujuan tidak ada di sini', ['Cek lagi jarak dari persimpangan terakhir dengan hitungan langkahmu.']);
      return;
    }
    const o = this.objectives;
    o[o.length - 1].done = true;
    const ok = this.checked.map((e) => e !== null && e <= Route.JUNCTION_OK);
    const n = ok.filter(Boolean).length;
    const started = o[1].done;
    this.checked.forEach((e, k) => {
      const j = r.crossroads[k];
      if (e === null) this.lessons.push(`Persimpangan ${k + 1} dilewati tanpa dicek. Di lapangan, salah cabang paling mudah terjadi di persimpangan.`);
      else if (e > Route.JUNCTION_OK) this.lessons.push(`Persimpangan ${k + 1} ditandai ${M(e)} m dari letak sebenarnya: persimpangan salah dikenali. Cocokkan jumlah cabang dan arah tiap cabang dengan peta.`);
      this.c.map.reveals.push({ x: j[0], z: j[1], label: `Persimpangan ${k + 1}`, color: '#1d8a3a' });
    });
    if (!started) this.lessons.push('Resection di titik awal tidak dilakukan. Navigasi terbuka dimulai dengan memastikan posisi awal sebelum berangkat.');
    if (this.startErr !== null && this.startErr > 100) this.lessons.push(`Resection awal meleset ${this.startErr} m; perbaiki dengan memilih titik ekstrem yang berselisih arah mendekati 90°.`);
    if (this.falseReports) this.lessons.push(`${this.falseReports} kali lapor tiba sebelum sampai di pos. Ukur jarak dari persimpangan terakhir di peta dan hitung langkah sampai jarak itu habis.`);
    this.lessons.push('Navigasi terbuka: resection di titik awal, lalu persimpangan dan hitungan langkah sebagai titik cek di sepanjang jalan.');
    this.c.map.redraw();
    this.finish(n === ok.length && started, 40 + 35 * (n / ok.length) + this.timeScore(25) - 5 * this.falseReports, [
      ['Persimpangan dikenali benar', `${n} dari ${ok.length}`],
      ['Galat resection awal', this.startErr === null ? '—' : `${this.startErr} m`],
      ['Lapor tiba terlalu awal', String(this.falseReports)],
    ]);
  }

  devInfo(): [string, string][] {
    const r = this.c.sites.route, h = here(this.c);
    return [
      ['Jarak ke titik awal', `${M(dist(h, r.start))} m (resection awal dihitung <63 m)`],
      ...r.crossroads.map((j, k): [string, string] => {
        const e = this.checked[k];
        return [`Persimpangan ${k + 1}`, `${M(dist(h, j))} m · ${e === null ? 'belum dicek' : `tanda meleset ${M(e)} m (benar ≤${M(Route.JUNCTION_OK)} m)`} (cek <38 m)`];
      }),
      ['Jarak ke pos tujuan', `${M(dist(h, r.dest))} m (lapor tiba ≤20 m)`],
      ['Langkah sejak cek terakhir', `${Math.round(this.c.pace.steps)} (${Math.round(this.c.pace.metres)} m)`],
      ['Galat resection awal', this.startErr === null ? '—' : `${this.startErr} m`],
    ];
  }

  devPoints() {
    const r = this.c.sites.route;
    return [{ label: 'Titik awal', p: r.start }, ...r.crossroads.map((p, k) => ({ label: `Persimpangan ${k + 1}`, p })), { label: 'Pos tujuan', p: r.dest }];
  }

  devSolution() {
    const r = this.c.sites.route, js = r.crossroads;
    const leg = (a: P, b: P) => `garis lurus ${M(dist(a, b))} m, azimut ${deg(magneticOf(azimuthTo(a[0], a[1], b[0], b[1])))}`;
    const last = js[js.length - 1], d = M(dist(last, r.dest));
    return [
      'Utarakan peta (selisih ≤5°).',
      ...this.resectionKey(r.start),
      `Tekan Tandai posisiku dan ketuk ${fmtCoord(r.start)}.`,
      ...js.map((j, k) => `Ikuti jalan ke persimpangan ${k + 1} (${leg(k ? js[k - 1] : r.start, j)}). Tekan Cek persimpangan dan ketuk persimpangan itu di peta, ${fmtCoord(j)} (benar bila ≤${M(Route.JUNCTION_OK)} m).`),
      `Dari persimpangan ${js.length}, ikuti jalan ke pos bendera oranye (${leg(last, r.dest)}; di jalan sedikit lebih jauh, sekitar ${Math.round((d * DEFAULT_PACE) / 100)}+ langkah).`,
      `Di pos (≤20 m) tekan Lapor tiba.`,
    ];
  }
}

// ======================================================================= level 5: the summit climb (navtup)

/** The summit is reached within this many blocks (15 m) of the pillar. */
const SUMMIT_REACH = 6;

/**
 * Level 5: from the end of a footpath up through a young forest to the summit of Puncak Pasir Malang,
 * which cannot be seen from the path end. Resection at the path end, lock the compass on the summit,
 * then move. The compasman cannot walk on his own: before each move he sets the number of steps, and
 * the team walks them on the locked bearing, the penerabas felling the trees on the line with his
 * golok and the sweeper behind him clearing them off the lane.
 */
class SummitClimb extends Mission {
  private startP!: P;
  private summit!: P;
  private mark: P | null = null;
  private errM: number | null = null;
  private locked: number | null = null;
  /** The bearing locked for the first move (scored: it is the one taken from the plotted line). */
  private firstLock: number | null = null;
  /** Steps set per move. */
  private moves: number[] = [];
  private moveFrom = 0;
  private moveEnd: number | null = null;

  start() {
    const { sites, player } = this.c;
    this.c.restoreVegetation();
    this.startP = sites.summit.start;
    this.summit = sites.summit.target;
    player.teleport(this.startP[0], this.startP[1], azimuthTo(this.startP[0], this.startP[1], this.summit[0], this.summit[1]));
    this.c.team.fell = true;
    this.holdPlayer = true;
    this.showPace = true;
    this.orientCheck = true;
    this.haze = 0.35;
    this.par = 600;
    this.destination = { p: this.summit, label: 'Puncak Pasir Malang' };
    const calib = this.c.progress.paceCount ?? DEFAULT_PACE;
    this.briefing = [
      `Tim berdiri di ujung jalan setapak, di kaki Puncak Pasir Malang. Sasaran: puncaknya, di ${fmtCoord(this.summit)}. Tandai di peta sebelum berangkat.`,
      'Di antara ujung jalan dan puncak ada hutan muda yang rapat: puncak tidak terlihat dan tidak ada jalan. Ini navigasi tertutup.',
      '1. Resection: di ujung jalan masih terlihat beberapa titik ekstrem. Bidik dua (atau tiga), pasangkan di Catatan, gariskan back azimuth-nya, lalu tandai posisimu.',
      '2. Kunci kompas: di peta plot garis dari posisimu ke puncak, ukur azimutnya dengan busur dan jaraknya dengan penggaris, lalu kunci kompas pada azimut itu.',
      `3. Bergerak: sebagai compasman kamu tidak berjalan sendiri. Isi jumlah langkah, lalu tim maju di azimut terkunci. Penerabas menebas pohon di depan dengan golok, sweeper di belakangnya menyapu tebangan dari jalur. Langkahmu ${calib} per 100 m di medan datar; di hutan dan tanjakan tambahkan sekitar 20–30%.`,
      'Ulangi Maju sampai tim keluar dari hutan di puncak.',
    ];
    this.objectives = [
      { text: 'Resection di ujung jalan setapak (Tandai posisiku)', done: false },
      { text: 'Kunci kompas ke puncak', done: false },
      { text: 'Maju: isi jumlah langkah, tim menerabas hutan', done: false },
      { text: 'Sampai di puncak', done: false },
    ];
  }

  cleanup() {
    super.cleanup();
    this.c.team.reset();
    this.c.player.carried = false;
    this.c.lockCompass(null);
    this.c.restoreVegetation();
  }

  update(dt: number) {
    if (this.result) return;
    this.time += dt;
    const { team, pace } = this.c;
    if (this.moveEnd !== null && (pace.steps >= this.moveEnd || team.blocked)) this.stopMove(team.blocked);
    if (dist(here(this.c), this.summit) < SUMMIT_REACH) {
      this.objectives[3].done = true;
      this.complete();
    }
  }

  actions(): Action[] {
    if (this.moveEnd !== null) return [{ id: 'stop', label: 'Berhenti', run: () => this.stopMove(false) }];
    const acts: Action[] = [];
    if (!this.moves.length) {
      acts.push({ id: 'mark', label: this.errM === null ? 'Tandai posisiku' : 'Tandai ulang posisiku', primary: this.errM === null, run: () => void this.resect() });
    }
    acts.push({ id: 'lock', label: this.locked === null ? 'Kunci kompas' : `Kompas ${deg(this.locked)}`, primary: this.errM !== null && this.locked === null, run: () => void this.lock() });
    if (this.locked !== null) acts.push({ id: 'move', label: 'Maju … langkah', primary: true, run: () => void this.move() });
    return acts;
  }

  private async resect() {
    const m = await this.markMyPosition();
    if (!m || this.result) return;
    this.mark = m.p;
    this.errM = M(m.err);
    this.objectives[0].done = true;
    this.c.toast('Posisi ditandai', ['Plot garis dari posisimu ke puncak, ukur azimut dan jaraknya, lalu kunci kompas.']);
  }

  private async lock() {
    if (this.errM === null) {
      this.c.toast('Resection dulu', ['Garis ke puncak harus berangkat dari posisi yang sudah pasti. Tentukan posisimu dengan resection.']);
      return;
    }
    const v = await this.c.askNumbers('Kunci kompas ke puncak', [{ key: 'az', label: 'Azimut kompas (°)', value: this.locked ?? undefined }]);
    if (!v || !Number.isFinite(v.az) || this.result) return;
    this.locked = ((v.az % 360) + 360) % 360;
    if (!this.moves.length) this.firstLock = this.locked;
    this.c.lockCompass(this.locked);
    if (this.c.team.cutting) this.c.team.heading = gridOf(this.locked);
    this.objectives[1].done = true;
    this.c.notebook.notes.push(`Kompas dikunci ${deg(this.locked)}.`);
  }

  private async move() {
    if (this.locked === null) return;
    const calib = this.c.progress.paceCount ?? DEFAULT_PACE;
    const v = await this.c.askNumbers('Maju', [{ key: 'steps', label: `Jumlah langkah (${calib} langkah = 100 m datar)` }]);
    if (!v || !Number.isFinite(v.steps) || v.steps < 1 || this.result) return;
    const n = Math.min(2000, Math.round(v.steps));
    const { team, player, pace } = this.c;
    if (!team.cutting) {
      // first move: penerabas in front on the bearing, sweeper and stringlineman behind the compasman
      team.place(player, gridOf(this.locked));
      pace.reset();
    }
    this.moveFrom = pace.steps;
    this.moveEnd = pace.steps + n;
    this.moves.push(n);
    team.auto = true;
    this.objectives[2].done = true;
    this.c.notebook.notes.push(`Maju ${n} langkah pada ${deg(this.locked)}.`);
  }

  private stopMove(blocked: boolean) {
    const { team, pace } = this.c;
    team.auto = false;
    this.moveEnd = null;
    const walked = Math.round(pace.steps - this.moveFrom);
    this.c.toast(blocked ? `Terhalang setelah ${walked} langkah` : `Berhenti setelah ${walked} langkah`, [
      `Total ${Math.round(pace.steps)} langkah dari ujung jalan.`,
      blocked
        ? 'Tebing terlalu curam untuk didaki. Kunci kompas sedikit ke samping untuk memutarinya, lalu kembali ke azimut semula.'
        : 'Puncak belum tercapai? Bandingkan langkahmu dengan jarak di peta, lalu maju lagi.',
    ]);
  }

  private complete() {
    const { team, pace, map } = this.c;
    team.stopCutting();
    this.c.player.carried = false;
    const s = this.startP, t = this.summit;
    const trueAz = magneticOf(azimuthTo(s[0], s[1], t[0], t[1]));
    const legM = M(dist(s, t));
    const calib = this.c.progress.paceCount ?? DEFAULT_PACE;
    const flat = Math.round((legM * calib) / 100);
    const steps = Math.round(pace.steps);
    const lockErr = this.firstLock === null ? null : Math.abs(angleDiff(this.firstLock, trueAz));
    const stats: [string, string][] = [
      ['Galat resection', this.errM === null ? '—' : `${this.errM} m (batas 100 m)`],
      ['Azimut ujung jalan → puncak', deg(trueAz)],
      ['Kompas dikunci (gerakan pertama)', this.firstLock === null ? '—' : `${deg(this.firstLock)} (selisih ${lockErr!.toFixed(1)}°)`],
      ['Jarak ke puncak', `${legM} m (${flat} langkah datar)`],
      ['Langkah sampai puncak', `${steps} dalam ${this.moves.length} gerakan (${this.moves.join(' + ') || '—'})`],
      ['Pohon ditebang', String(team.felledCount)],
    ];
    if (this.errM === null) {
      this.lessons.push('Resection di ujung jalan tidak dilakukan. Tanpa posisi yang pasti, garis ke puncak tidak punya titik awal.');
    } else if (this.errM > 100) {
      this.lessons.push(`Resection meleset ${this.errM} m, sehingga garis ke puncak berangkat dari titik yang salah. Di hutan kesalahan ini tidak bisa dicek lagi.`);
    }
    this.crossingTip();
    if (this.pairs().wrong) this.lessons.push('Ada bidikan yang dipasangkan dengan simbol yang salah, sehingga garisnya berangkat dari tempat yang salah.');
    if (lockErr !== null) {
      this.lessons.push(lockErr > 3
        ? `Azimut yang dikunci berbeda ${Math.round(lockErr)}° dari garis ujung jalan → puncak. Pada ${legM} m selisih itu menggeser sekitar ${Math.round(legM * Math.sin((lockErr * Math.PI) / 180))} m; di hutan tidak ada titik ekstrem untuk mengoreksinya.`
        : 'Azimut yang dikunci tepat: garis dari posisi hasil resection ke puncak.');
    }
    if (steps > flat * 1.05) this.lessons.push(`Butuh ${steps} langkah untuk ${legM} m, lebih banyak dari ${flat} langkah di medan datar: tanjakan dan hutan memperpendek langkah.`);
    this.lessons.push('Navigasi tertutup: puncak tidak terlihat dari ujung jalan. Hanya azimut terkunci dan hitungan langkah yang membawa tim ke sana; penerabas membuka jalur, sweeper membersihkannya.');
    const passed = this.errM !== null && this.errM <= 100 && this.firstLock !== null;
    this.revealTruth(s, this.mark, `Ujung jalan (galat ${this.errM ?? '—'} m)`);
    map.reveals.push({ x: t[0], z: t[1], label: 'Puncak', color: '#1d8a3a', from: s });
    map.redraw();
    const resPts = this.errM === null ? 0 : 40 * clamp01(1 - this.errM / 150);
    const lockPts = lockErr === null ? 0 : 40 * clamp01(1 - (lockErr - 1) / 6);
    this.finish(passed, resPts + lockPts + this.timeScore(20), stats);
  }

  devInfo(): [string, string][] {
    const { team, pace } = this.c;
    const s = this.startP, t = this.summit;
    const legM = M(dist(s, t));
    const calib = this.c.progress.paceCount ?? DEFAULT_PACE;
    return [
      ['Galat resection', this.errM === null ? '—' : `${this.errM} m (lulus ≤100 m)`],
      ['Azimut ke puncak / dikunci', `${deg(magneticOf(azimuthTo(s[0], s[1], t[0], t[1])))} / ${this.locked === null ? '—' : deg(this.locked)} (pertama ${this.firstLock === null ? '—' : deg(this.firstLock)})`],
      ['Jarak', `${legM} m · langkah datar ${Math.round((legM * calib) / 100)}`],
      ['Langkah', `${Math.round(pace.steps)}${this.moveEnd === null ? '' : ` → ${Math.round(this.moveEnd)}`} · gerakan ${this.moves.join(' + ') || '—'}`],
      ['Jarak ke puncak', `${M(dist(here(this.c), t))} m (sampai <${M(SUMMIT_REACH)} m)`],
      ['Tim', team.cutting ? `${team.auto ? (team.chopping ? 'menebas' : 'maju') : 'berhenti'}${team.blocked ? ' · TERHALANG' : ''} · ${team.felledCount} pohon` : 'belum diatur'],
    ];
  }

  devPoints() { return [{ label: 'Ujung jalan', p: this.c.sites.summit.start }, { label: 'Puncak', p: this.c.sites.summit.target }]; }

  devSolution() {
    const s = this.c.sites.summit.start, t = this.c.sites.summit.target;
    const az = magneticOf(azimuthTo(s[0], s[1], t[0], t[1]));
    const legM = M(dist(s, t));
    const calib = this.c.progress.paceCount ?? DEFAULT_PACE;
    const flat = Math.round((legM * calib) / 100);
    return [
      'Utarakan peta (selisih ≤5°).',
      ...this.resectionKey(s),
      `Tekan Tandai posisiku dan ketuk ${fmtCoord(s)}. Lulus bila galat ≤100 m.`,
      `Di peta letakkan busur di posisimu dan arahkan ke puncak: azimut ${deg(az)}, jarak ${legM} m.`,
      `Tekan Kunci kompas: ${Math.round(az)}.`,
      `Tekan Maju: sekitar ${Math.round(flat * 1.25)} langkah (${flat} langkah datar × 1,25 untuk hutan dan tanjakan). Bila belum sampai, Maju lagi; puncak tercapai dalam ${M(SUMMIT_REACH)} m.`,
    ];
  }
}

// ======================================================================= level 6: the final mission

/** Navtup leg on a locked bearing with the team under the joystick (the final mission). */
abstract class Navtup extends Mission {
  protected startP!: P;
  protected target!: P;
  protected locked: number | null = null;
  protected targetSteps: number | null = null;
  protected legEndErr: number | null = null;
  protected stepsAtEnd = 0;
  protected found = false;
  protected teamPlaced = false;

  cleanup() {
    super.cleanup();
    this.c.team.reset();
    this.c.player.carried = false;
    this.c.lockCompass(null);
  }

  protected idx(name: string) {
    return this.objectives.findIndex((o) => o.text.startsWith(name));
  }

  update(dt: number) {
    if (this.result) return;
    this.time += dt;
    const { player } = this.c;
    if (dist([player.x, player.z], this.target) < 3 && !this.found) {
      this.found = true;
      if (this.legEndErr === null) this.recordLegEnd();
      this.objectives[this.objectives.length - 1].done = true;
      this.complete();
    }
  }

  actions(): Action[] {
    const { team } = this.c;
    const acts: Action[] = [];
    if (!team.cutting) {
      acts.push({ id: 'lock', label: this.locked === null ? 'Kunci kompas' : `Kompas ${Math.round(this.locked)}°`, run: () => void this.lock() });
      if (this.locked !== null && this.legEndErr === null) acts.push({ id: 'team', label: 'Atur posisi tim', primary: true, run: () => this.placeTeam() });
    } else {
      acts.push(
        { id: 'left', label: '◀ Kiri', run: () => {}, hold: (d) => { team.steer = d ? -1 : 0; } },
        { id: 'right', label: 'Kanan ▶', run: () => {}, hold: (d) => { team.steer = d ? 1 : 0; } },
        { id: 't90l', label: '↶ 90°', run: () => team.turn90(-1) },
        { id: 't90r', label: '90° ↷', run: () => team.turn90(1) },
        { id: 'tally', label: 'Hitung ulang', run: () => { this.c.pace.tally = 0; } },
        { id: 'end', label: 'Selesai leg', primary: true, run: () => this.endLeg() },
      );
    }
    return acts;
  }

  private async lock() {
    const v = await this.c.askNumbers('Kunci kompas', [
      { key: 'az', label: 'Azimut kompas (°)', value: this.locked ?? undefined },
      { key: 'steps', label: `Target langkah (kalibrasi: ${this.c.progress.paceCount ?? DEFAULT_PACE} / 100 m)`, value: this.targetSteps ?? undefined },
    ]);
    if (!v || !Number.isFinite(v.az)) return;
    this.locked = ((v.az % 360) + 360) % 360;
    this.targetSteps = Number.isFinite(v.steps) ? Math.round(v.steps) : null;
    this.c.lockCompass(this.locked);
    this.c.team.locked = this.locked;
    const k = this.idx('Kunci');
    if (k >= 0) this.objectives[k].done = true;
    this.c.notebook.notes.push(`Kompas dikunci ${Math.round(this.locked)}°` + (this.targetSteps ? `, target ${this.targetSteps} langkah.` : '.'));
  }

  protected placeTeam() {
    const { team, player, pace } = this.c;
    if (this.locked === null) return;
    // Team faces the locked bearing (converted to grid for movement).
    team.place(player, gridOf(this.locked));
    this.teamPlaced = true;
    pace.reset();
    const k = this.idx('Atur');
    if (k >= 0) this.objectives[k].done = true;
    this.c.toast('Tim siap menerabas', ['Dorong joystick ke depan (atau W) untuk maju. Pantau penunjuk arah dan beri aba-aba Kiri/Kanan.']);
  }

  protected recordLegEnd() {
    const { player } = this.c;
    this.legEndErr = M(dist([player.x, player.z], this.target));
    this.stepsAtEnd = Math.round(this.c.pace.steps);
  }

  protected endLeg() {
    const { team } = this.c;
    team.stopCutting();
    this.c.player.carried = false;
    if (this.legEndErr === null) this.recordLegEnd();
    const e = this.legEndErr!;
    if (e <= 7) return; // found right away (update() completes)
    this.c.toast(`Leg selesai (${this.stepsAtEnd} langkah)`, [
      e < 40 ? 'Sasaran belum terlihat. Cari dengan pola kotak kecil di sekitar titik ini.' : 'Sasaran tidak terlihat di sekitar. Cari dengan pola kotak, atau ikuti stringline kembali ke titik terakhir yang pasti dan coba lagi.',
      'Kamu sekarang bisa berjalan bebas; tim mengikuti.',
    ]);
  }

  protected complete() {
    const { team } = this.c;
    team.stopCutting();
    this.c.player.carried = false;
    const e = this.legEndErr ?? 0;
    const magAz = magneticOf(azimuthTo(this.startP[0], this.startP[1], this.target[0], this.target[1]));
    const legM = M(dist(this.startP, this.target));
    const calib = this.c.progress.paceCount ?? DEFAULT_PACE;
    const idealSteps = Math.round((legM * calib) / 100);
    const stats: [string, string][] = [
      ['Galat di akhir leg', `${e} m`],
      ['Azimut seharusnya', `${Math.round(magAz)}°`],
      ['Kompas dikunci', this.locked === null ? '—' : `${Math.round(this.locked)}°`],
      ['Panjang leg', `${legM} m`],
      ['Langkah saat akhir leg', `${this.stepsAtEnd} (target ${this.targetSteps ?? '—'}, hitungan datar ${idealSteps})`],
    ];
    if (this.locked !== null && Math.abs(angleDiff(this.locked, magAz)) > 3) {
      this.lessons.push(`Azimut yang dikunci berbeda ${Math.round(Math.abs(angleDiff(this.locked, magAz)))}° dari garis plot. Ukur ulang dengan busur dari titik resection terakhir ke sasaran.`);
    }
    if (this.stepsAtEnd > idealSteps * 1.05) this.lessons.push('Hitungan langkah lebih banyak dari hitungan di medan datar: tanjakan dan semak memperpendek langkah.');
    this.lessons.push('Navigasi tertutup: tanpa titik ekstrem, tim hanya mengandalkan azimut terkunci dan hitungan langkah.');
    const lockPts = this.locked === null ? 0 : 20 * clamp01(1 - (Math.abs(angleDiff(this.locked, magAz)) - 1) / 6);
    const pacePts = this.targetSteps ? 15 * clamp01(1 - Math.abs(this.stepsAtEnd - this.targetSteps) / (this.targetSteps * 0.3)) : 0;
    const missed: string[] = [];
    if (this.locked === null) missed.push('kompas tidak dikunci');
    if (!this.teamPlaced) missed.push('tim tidak diatur');
    if (missed.length) this.lessons.unshift(`Pos sasaran ditemukan tanpa alur navigasi tertutup (${missed.join(', ')}). Di hutan lebat sasaran hanya bisa dicapai dengan azimut terkunci dan tim yang menerabas.`);
    const passed = missed.length === 0;
    this.c.map.reveals.push({ x: this.target[0], z: this.target[1], label: 'Pos sasaran', color: '#1d8a3a', from: this.startP });
    this.finish(passed, 50 * clamp01(1 - (e - 10) / 70) + lockPts + pacePts + this.timeScore(15), stats);
  }

  devInfo(): [string, string][] {
    const { team, pace } = this.c;
    const gridAz = azimuthTo(this.startP[0], this.startP[1], this.target[0], this.target[1]);
    const legM = M(dist(this.startP, this.target));
    const calib = this.c.progress.paceCount ?? DEFAULT_PACE;
    const dev = team.deviation();
    const teamState = team.cutting
      ? `menerabas · arah ${deg(magneticOf(team.heading))} · simpang ${dev === null ? '—' : `${dev.toFixed(1)}°`}${team.blocked ? ' · TERHALANG' : ''}`
      : team.active ? 'mengikuti' : 'belum diatur';
    return [
      ['Azimut kompas benar', deg(magneticOf(gridAz))],
      ['Kompas dikunci', this.locked === null ? '—' : deg(this.locked)],
      ['Panjang leg', `${legM} m · langkah datar ${Math.round((legM * calib) / 100)} · target ${this.targetSteps ?? '—'}`],
      ['Langkah sekarang', String(Math.round(pace.steps))],
      ['Jarak ke sasaran', `${M(dist(here(this.c), this.target))} m (ditemukan <7,5 m)`],
      ['Tim', teamState],
      ['Galat akhir leg', this.legEndErr === null ? '—' : `${this.legEndErr} m (${this.stepsAtEnd} langkah)`],
    ];
  }

  /** Solution steps for the navtup leg from startP to the target. */
  protected legSolution(): string[] {
    const s = this.startP, t = this.target;
    const mag = magneticOf(azimuthTo(s[0], s[1], t[0], t[1]));
    const legM = M(dist(s, t));
    const calib = this.c.progress.paceCount ?? DEFAULT_PACE;
    const flat = Math.round((legM * calib) / 100);
    return [
      `Di peta letakkan busur di ${fmtCoord(s)} dan arahkan ke pos sasaran: azimut ${deg(mag)}, panjang ${legM} m (opsional: Gariskan).`,
      `Tekan Kunci kompas: azimut ${Math.round(mag)}, target langkah sekitar ${Math.round(flat * 1.25)} (${flat} langkah datar × 1,25 untuk hutan dan tanjakan).`,
      'Tekan Atur posisi tim, lalu maju (joystick/W). Tahan Kiri/Kanan agar simpangan di penunjuk tetap dekat 0°.',
      'Saat hitungan langkah mendekati target, tekan Selesai leg dan cari pos (ditemukan <7,5 m).',
    ];
  }
}

class FinalMission extends Navtup {
  private err1: number | null = null;
  private err2: number | null = null;
  private edgeP: P | null = null;

  start() {
    const { sites, player } = this.c;
    this.target = sites.final.target;
    this.startP = sites.final.start;
    player.teleport(this.startP[0], this.startP[1], 200);
    this.place(targetPost(), this.target);
    this.destination = { p: this.target, label: 'Pos sasaran' };
    this.orientCheck = true;
    this.showPace = true;
    this.par = 1500;
    this.briefing = [
      `Misi akhir. Sasaran: pos berbendera oranye di dalam hutan lebat, di ${fmtCoord(this.target)}. Tandai di peta sebelum berangkat.`,
      'Posisimu belum diketahui. Utarakan peta dan lakukan resection. Lalu bergerak ke tepi hutan, berhenti di titik terakhir yang masih bisa melihat titik ekstrem, dan lakukan resection terakhir di sana.',
      'Dari titik itu, plot garis lurus ke sasaran, kunci kompas, hitung target langkah (tambahkan sekitar 20–30% untuk hutan dan tanjakan), atur tim, dan menerabas.',
    ];
    this.objectives = [
      { text: 'Utarakan peta', done: false },
      { text: 'Resection di titik awal (Tandai posisiku)', done: false },
      { text: 'Resection terakhir di tepi hutan', done: false },
      { text: 'Kunci kompas dan isi target langkah', done: false },
      { text: 'Atur posisi tim', done: false },
      { text: 'Menerabas dan temukan pos sasaran', done: false },
    ];
  }

  update(dt: number) {
    if (this.result) return;
    if (this.orientDone()) this.objectives[0].done = true;
    super.update(dt);
  }

  actions(): Action[] {
    const acts: Action[] = [];
    if (!this.c.team.cutting && this.legEndErr === null) {
      acts.push({ id: 'mark', label: 'Tandai posisiku', run: () => void this.resect() });
    }
    if (this.err2 === null) return acts;
    return [...acts, ...super.actions()];
  }

  /** Distance (blocks) to the nearest forest cell within 20 blocks, or Infinity. */
  private forestNear(x: number, z: number) {
    const { w } = this.c;
    const N = w.size;
    let best = Infinity;
    for (let dz = -20; dz <= 20; dz += 1) for (let dx = -20; dx <= 20; dx += 1) {
      const xi = Math.floor(x + dx), zi = Math.floor(z + dz);
      if (xi < 0 || zi < 0 || xi >= N || zi >= N) continue;
      if (w.zone[zi * N + xi] === Zone.Forest) best = Math.min(best, Math.hypot(dx, dz));
    }
    return best;
  }

  private async resect() {
    const m = await this.markMyPosition();
    if (!m || this.result) return;
    const { player } = this.c;
    const here: P = [player.x, player.z];
    if (this.err1 === null) {
      this.err1 = M(m.err);
      this.objectives[1].done = true;
      this.c.toast('Posisi awal ditandai', ['Sekarang bergerak ke tepi hutan dan lakukan resection terakhir di sana.']);
      return;
    }
    const fd = this.forestNear(here[0], here[1]);
    if (fd <= 15) {
      this.err2 = M(m.err);
      this.edgeP = here;
      this.startP = here;
      this.objectives[2].done = true;
      this.c.toast('Resection terakhir ditandai', ['Plot garis dari titik ini ke sasaran, lalu kunci kompas.']);
    } else {
      this.c.toast('Belum di tepi hutan', ['Resection terakhir dilakukan di tepi hutan, di titik terakhir yang masih bisa melihat titik ekstrem.']);
    }
  }

  protected complete() {
    const before = this.lessons.length;
    super.complete();
    const r = this.result!;
    const e1 = this.err1 ?? 999, e2 = this.err2 ?? 999;
    r.stats.unshift(['Galat resection awal', `${this.err1 ?? '—'} m`], ['Galat resection terakhir', `${this.err2 ?? '—'} m`]);
    if (this.err2 !== null && e2 > 80) r.lessons.splice(before, 0, 'Resection terakhir meleset jauh, sehingga garis navigasi tertutup berangkat dari titik yang salah. Hasil akhir sangat bergantung pada resection terakhir.');
    const skipped = [
      !this.objectives[0].done && 'peta tidak diutarakan',
      this.err1 === null && 'resection awal tidak dilakukan',
      this.err2 === null && 'resection terakhir di tepi hutan tidak dilakukan',
    ].filter((s): s is string => !!s);
    if (skipped.length) r.lessons.splice(before, 0, `Alur misi akhir belum lengkap: ${skipped.join(', ')}.`);
    // Final score: blend navtup score with both resections.
    r.score = Math.round(0.6 * r.score + 20 * clamp01(1 - e1 / 150) + 20 * clamp01(1 - e2 / 150));
    // Pass rule: the whole flow is done (navtup part checked by super.complete()).
    r.passed &&= skipped.length === 0;
    if (this.edgeP) this.c.map.reveals.push({ x: this.edgeP[0], z: this.edgeP[1], label: 'Titik resection terakhir', color: '#1d6ad8' });
    this.c.map.redraw();
  }

  devInfo(): [string, string][] {
    const fd = this.forestNear(this.c.player.x, this.c.player.z);
    return [
      ['Galat resection awal / terakhir', `${this.err1 ?? '—'} m / ${this.err2 ?? '—'} m`],
      ['Jarak ke hutan', fd === Infinity ? '>50 m' : `${M(fd)} m (resection terakhir ≤38 m)`],
      ...super.devInfo(),
    ];
  }

  devPoints() {
    const pts = [{ label: 'Titik awal', p: this.c.sites.final.start }, { label: 'Pos sasaran', p: this.target }];
    if (this.edgeP) pts.splice(1, 0, { label: 'Titik resection terakhir', p: this.edgeP });
    return pts;
  }

  devSolution() {
    const start = this.c.sites.final.start, t = this.target;
    const h = here(this.c);
    // The last resection happens wherever the player stops at the forest edge: its answer follows them.
    const edgeSteps = this.edgeP
      ? [`Resection terakhir sudah ditandai di ${fmtCoord(this.edgeP)}.`, ...this.legSolution()]
      : dist(h, start) < 30
        ? ['Di tepi hutan lakukan resection terakhir. Kunci jawabannya muncul di sini setelah kamu meninggalkan titik awal.']
        : ['Resection terakhir dari posisimu sekarang:', ...this.resectionKey(h), `Tekan Tandai posisiku dan ketuk ${fmtCoord(h)}.`, 'Langkah navigasi tertutup muncul di sini setelah resection terakhir.'];
    return [
      'Utarakan peta (selisih ≤5°).',
      ...this.resectionKey(start),
      `Tekan Tandai posisiku dan ketuk ${fmtCoord(start)}.`,
      `Berjalan ke arah pos sasaran (azimut ${deg(magneticOf(azimuthTo(start[0], start[1], t[0], t[1])))}) sampai "Jarak ke hutan" di info misi ≤38 m, di tempat yang masih melihat titik ekstrem.`,
      ...edgeSteps,
    ];
  }
}

export function createMission(level: number, c: Ctx): Mission | null {
  switch (level) {
    case 2: return new Resection(c, level);
    case 3: return new Intersection(c, level);
    case 4: return new Route(c, level);
    case 5: return new SummitClimb(c, level);
    case 6: return new FinalMission(c, level);
    default: return null;
  }
}
