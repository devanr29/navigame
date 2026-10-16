// Developer mode (/developer): a panel for testers looking for bugs. Shows the exact position and the
// answers the missions check against (true azimuths, distances, pass limits), the active mission's
// internal state, teleports to mission points, and a log that flags suspicious mission behaviour
// (objectives un-ticking, a result that disagrees with the objectives, NaN in the debrief, the player
// under the ground, runtime errors). "Salin laporan" copies everything as JSON for a bug report.
import { BLOCK_M, Surface, Zone, type WorldData } from '../gen/constants';
import type { Mission, Result } from '../game/missions';
import type { PaceCounter } from '../game/pace';
import type { P, Sites } from '../game/sites';
import type { Team } from '../game/team';
import { elevationM, fmtDMS, latSecAt, lonSecAt } from '../map/geo';
import type { MapView } from '../map/mapView';
import type { Player } from '../player/player';
import { azimuthOfYaw, azimuthTo, backAzimuth, angleDiff, getDeclination, magneticOf, type Sight } from '../tools/sight';
import type { Notebook } from '../ui/notebook';
import { el } from '../ui/screens';

export interface DevHost {
  seed: string;
  w: WorldData;
  sites: Sites;
  sight: Sight;
  player: Player;
  map: MapView;
  notebook: Notebook;
  pace: PaceCounter;
  team: Team;
  mission(): Mission | null;
  inField(): boolean;
  mapOpen(): boolean;
  /** Camera (eye) position and the current view distance, for the visible-landmark answer key. */
  eye(): [number, number, number];
  viewRange(): number;
  tools(): string[];
  teleport(x: number, z: number): void;
  teleportViaMap(): void;
  grantAllTools(): void;
  setFlying(on: boolean): void;
}

type LogLevel = 'info' | 'warn' | 'error';
interface LogEntry { t: string; level: LogLevel; msg: string }

const M = (blocks: number) => Math.round(blocks * BLOCK_M);
const deg = (a: number) => `${String(Math.round(a)).padStart(3, '0')}°`;
const ZONE_NAME: Record<number, string> = { [Zone.Open]: 'terbuka', [Zone.Forest]: 'hutan' };
const SURFACE_NAME: Record<number, string> = Object.fromEntries(Object.entries(Surface).map(([k, v]) => [v, k]));

function rows(list: [string, string][]) {
  const t = el('table', 'dev-rows');
  for (const [k, v] of list) t.append(el('tr', '', el('td', '', k), el('td', '', v)));
  return t;
}

export class DevTools {
  private root = el('div', '');
  private panel = el('div', 'dev-panel');
  private posEl = el('div', '');
  private keyEl = el('div', '');
  private missionEl = el('div', '');
  private pointsEl = el('div', 'dev-points');
  private logEl = el('div', 'dev-log');
  private flyBtn: HTMLButtonElement;
  private upDown = el('div', 'dev-updown');
  private log: LogEntry[] = [];
  private seen = new Set<string>();
  private timer = 0;
  private pointsKey = '';

  // mission watch state
  private watched: Mission | null = null;
  private level = 0;
  private prevDone: boolean[] = [];
  private lastTime = 0;
  private stuckFor = 0;
  private resultSeen = false;
  private resultFor = 0;
  private flying = false;
  private mapWasOpen = false;

  constructor(private h: DevHost) {
    this.root.id = 'dev';
    const toggle = el('button', 'btn small dev-toggle', 'DEV');
    toggle.title = 'Panel developer (tombol `)';
    toggle.addEventListener('click', () => { this.togglePanel(); toggle.blur(); });
    const button = (label: string, fn: () => void, title = '') => {
      const b = el('button', 'btn ghost small', label);
      if (title) b.title = title;
      // Blur so Space (fly up) does not click the button again.
      b.addEventListener('click', () => { fn(); b.blur(); });
      return b;
    };
    this.flyBtn = button('Terbang', () => this.setFlying(!this.flying), 'Terbang (F). Naik: Spasi/E, turun: Q/Ctrl, cepat: Shift');
    this.panel.hidden = true;
    this.panel.append(
      el('div', 'dev-bar',
        this.flyBtn,
        button('Teleport (peta)', () => this.h.inField() && this.h.teleportViaMap(), 'Ketuk titik di peta lalu Kirim'),
        button('Semua alat', () => { this.h.grantAllTools(); this.add('info', 'Semua alat diberikan.'); }),
        button('Salin laporan', () => void this.copyReport()),
        button('Bersihkan log', () => { this.log = []; this.seen.clear(); this.renderLog(); }),
      ),
      el('h4', '', 'Misi'), this.missionEl, this.pointsEl,
      el('h4', '', 'Posisi'), this.posEl,
      el('h4', '', 'Kunci jawaban: titik ekstrem & bidikan'), this.keyEl,
      el('h4', '', 'Log'), this.logEl,
    );
    // On-screen climb/descend while flying (touch devices have no Space/Q).
    const hold = (label: string, v: number) => {
      const b = el('button', 'btn round', label);
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); b.setPointerCapture(e.pointerId); this.onUp(v); });
      b.addEventListener('pointerup', () => this.onUp(0));
      b.addEventListener('pointercancel', () => this.onUp(0));
      return b;
    };
    this.upDown.append(hold('▲', 1), hold('▼', -1));
    this.upDown.hidden = true;
    this.root.append(toggle, this.panel, this.upDown);
    document.body.append(this.root);

    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.code === 'Backquote') this.togglePanel();
      if (e.code === 'KeyF' && this.h.inField()) this.setFlying(!this.flying);
    });
    window.addEventListener('error', (e) => this.add('error', `Error: ${e.message} (${e.filename?.split('/').pop()}:${e.lineno})`));
    window.addEventListener('unhandledrejection', (e) => this.add('error', `Promise ditolak: ${String(e.reason?.message ?? e.reason)}`));
    this.add('info', `Mode developer aktif · seed ${h.seed}. F = terbang, \` = panel.`);
  }

  /** Called with the on-screen up/down value; the game forwards it to the input. */
  onUp: (v: number) => void = () => {};

  private togglePanel() {
    this.panel.hidden = !this.panel.hidden;
    if (!this.panel.hidden) {
      document.exitPointerLock?.();
      this.render();
    }
  }

  setFlying(on: boolean) {
    this.flying = on;
    this.h.setFlying(on);
    this.flyBtn.classList.toggle('on', on);
    this.upDown.hidden = !on || !matchMedia('(pointer: coarse)').matches;
    this.add('info', on ? 'Terbang: aktif (penghitung langkah berhenti saat terbang).' : 'Terbang: mati.');
  }

  add(level: LogLevel, msg: string, onceKey?: string) {
    if (onceKey) {
      if (this.seen.has(onceKey)) return;
      this.seen.add(onceKey);
    }
    const m = this.h.mission();
    const t = m ? `L${this.level} ${Math.floor(m.time / 60)}:${String(Math.floor(m.time % 60)).padStart(2, '0')}` : new Date().toLocaleTimeString();
    this.log.unshift({ t, level, msg });
    if (this.log.length > 200) this.log.pop();
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.info)(`[dev] ${msg}`);
    if (!this.panel.hidden) this.renderLog();
  }

  // ------------------------------------------------------------------ mission lifecycle

  missionStarted(m: Mission, level: number) {
    this.watched = m;
    this.level = level;
    this.prevDone = m.objectives.map((o) => o.done);
    this.lastTime = m.time;
    this.stuckFor = 0;
    this.resultSeen = false;
    this.resultFor = 0;
    this.pointsKey = '';
    this.add('info', `Level ${level} dimulai: ${m.objectives.length} objektif, par ${m.par} s, deklinasi ${m.declination}°, kabut ${m.haze}.`);
    for (const [k, v] of m.devInfo()) this.check(`${k}: ${v}`, `awal ${k}`);
  }

  missionEnded(level: number, r: Result) {
    this.add(r.passed ? 'info' : 'warn', `Level ${level} selesai: ${r.passed ? 'LULUS' : 'belum lulus'}, skor ${r.score}. ${r.stats.map(([k, v]) => `${k}: ${v}`).join(' · ')}`);
    this.watched = null;
  }

  /** Level 1 (quiz only) has no field mission; still record its result. */
  quizEnded(r: Result) {
    this.add('info', `Level 1 selesai: skor ${r.score}.`);
    this.validateResult(r, null);
  }

  // ------------------------------------------------------------------ per frame

  tick(dt: number) {
    // The map uses the whole left edge (bar, notes, tool dock): step aside while it is open.
    const mapOpen = this.h.mapOpen();
    if (mapOpen !== this.mapWasOpen) {
      this.mapWasOpen = mapOpen;
      this.root.hidden = mapOpen;
    }
    this.timer += dt;
    if (this.timer < 0.25) return;
    const step = this.timer;
    this.timer = 0;
    this.checkInvariants(step);
    if (!this.panel.hidden) this.render();
  }

  private check(text: string, key: string) {
    if (/NaN|undefined|Infinity/.test(text)) this.add('error', `Nilai tidak valid di info misi: ${text}`, key);
  }

  private checkInvariants(dt: number) {
    const { player, w, pace } = this.h;
    const N = w.size;
    if (this.h.inField()) {
      if (![player.x, player.z, player.footY, player.yaw, player.pitch].every(Number.isFinite)) {
        this.add('error', `Posisi pemain tidak valid: x=${player.x} z=${player.z} y=${player.footY}`, 'player-nan');
      } else if (player.x < 0 || player.z < 0 || player.x >= N || player.z >= N) {
        this.add('error', `Pemain di luar dunia: ${player.x.toFixed(1)}, ${player.z.toFixed(1)}`, 'player-out');
      } else if (!player.flying) {
        const i = Math.floor(player.z) * N + Math.floor(player.x);
        if (player.footY < w.height[i] - 0.6) this.add('warn', `Pemain di bawah tanah di ${player.x.toFixed(1)}, ${player.z.toFixed(1)} (kaki ${player.footY.toFixed(2)}, tanah ${w.height[i]}).`, `under-${i}`);
        if (w.solid[i]) this.add('warn', `Pemain berdiri di dalam sel padat (${Math.floor(player.x)}, ${Math.floor(player.z)}).`, `solid-${i}`);
      }
      if (!Number.isFinite(pace.steps) || !Number.isFinite(pace.metres)) this.add('error', `Penghitung langkah tidak valid: ${pace.steps} / ${pace.metres}`, 'pace-nan');
      this.h.notebook.readings.forEach((r, k) => {
        if (!Number.isFinite(r.azimuth) || r.azimuth < 0 || r.azimuth >= 360) this.add('error', `Bidikan #${k + 1} azimut tidak valid: ${r.azimuth}`, `reading-${k}`);
      });
    }

    const m = this.watched;
    if (!m || m !== this.h.mission()) return;
    // objectives ticking and un-ticking
    m.objectives.forEach((o, k) => {
      const was = this.prevDone[k] ?? false;
      if (o.done && !was) this.add('info', `✓ Objektif ${k + 1}: ${o.text}`);
      if (!o.done && was) this.add('warn', `Objektif ${k + 1} kembali belum selesai: ${o.text}`);
    });
    if (m.objectives.length !== this.prevDone.length) this.add('warn', `Jumlah objektif berubah: ${this.prevDone.length} → ${m.objectives.length}`);
    this.prevDone = m.objectives.map((o) => o.done);
    for (const [k, v] of m.devInfo()) this.check(`${k}: ${v}`, `info-${k}-${v}`);

    if (!m.result) {
      // The clock should run in the field (also while the map is open).
      if (this.h.inField() && !document.hidden) {
        this.stuckFor = m.time > this.lastTime ? 0 : this.stuckFor + dt;
        if (this.stuckFor > 2) this.add('warn', 'Waktu misi tidak bertambah selama 2 detik di lapangan.', `stuck-${this.level}`);
      }
      this.lastTime = m.time;
    } else {
      if (!this.resultSeen) {
        this.resultSeen = true;
        this.add('info', `Hasil dihitung: ${m.result.passed ? 'lulus' : 'belum lulus'}, skor ${m.result.score}.`);
        this.validateResult(m.result, m);
      }
      this.resultFor += dt;
      if (this.resultFor > 4 && this.h.inField()) this.add('error', 'Hasil sudah ada, tetapi lapangan tidak berakhir setelah 4 detik.', `noend-${this.level}`);
    }
  }

  private validateResult(r: Result, m: Mission | null) {
    if (!Number.isFinite(r.score) || r.score < 0 || r.score > 100) this.add('error', `Skor di luar 0–100: ${r.score}`);
    for (const [k, v] of r.stats) if (/NaN|undefined|Infinity|null/.test(`${k} ${v}`)) this.add('error', `Statistik debrief tidak valid: ${k} = ${v}`);
    for (const l of r.lessons) if (/NaN|undefined|Infinity/.test(l)) this.add('error', `Pelajaran debrief tidak valid: ${l}`);
    if (!m) return;
    const quit = r.lessons.includes('Misi dihentikan.');
    const open = m.objectives.filter((o) => !o.done && !o.optional);
    if (r.passed && open.length && !quit) {
      this.add('warn', `Lulus padahal objektif wajib belum selesai: ${open.map((o) => o.text).join(' | ')}`);
    }
    if (!r.passed && !open.length && !quit) this.add('warn', 'Semua objektif wajib selesai tetapi hasilnya belum lulus (cek batas lulus di info misi).');
  }

  // ------------------------------------------------------------------ rendering

  private positionRows(): [string, string][] {
    const { player, w, map } = this.h;
    const N = w.size;
    const xi = Math.floor(player.x), zi = Math.floor(player.z);
    const i = zi * N + xi;
    const inside = xi >= 0 && zi >= 0 && xi < N && zi < N;
    const grid = azimuthOfYaw(player.yaw);
    const out: [string, string][] = [
      ['Blok (x, z)', `${player.x.toFixed(2)}, ${player.z.toFixed(2)}`],
      ['Meter dari pojok barat laut', `${M(player.x)} m T, ${M(player.z)} m S`],
      ['Koordinat', `${fmtDMS(latSecAt(player.z), true, 'LS')}, ${fmtDMS(lonSecAt(player.x), true, 'BT')}`],
      ['Ketinggian', inside ? `${Math.round(elevationM(player.footY))} mdpl (kaki ${player.footY.toFixed(2)}, tanah ${w.height[i]})` : '—'],
      ['Zona / permukaan', inside ? `${ZONE_NAME[w.zone[i]] ?? w.zone[i]} / ${SURFACE_NAME[w.surface[i]] ?? w.surface[i]}${w.water[i] >= 0 ? ' / air' : ''}${w.solid[i] ? ' / PADAT' : ''}` : 'di luar dunia'],
      ['Menghadap', `peta ${deg(grid)} · kompas ${deg(magneticOf(grid))} · pitch ${((player.pitch * 180) / Math.PI).toFixed(0)}° · deklinasi ${getDeclination()}°`],
      ['Status', `${player.flying ? 'TERBANG' : 'jalan'}${player.carried ? ' · dibawa tim' : ''}${player.frozen ? ' · diam (bidik/catatan)' : ''}`],
      ['Alat', this.h.tools().join(', ') || '—'],
    ];
    if (map.orientFacing !== null && this.h.mapOpen()) out.push(['Orientasi peta', `selisih ${map.orientationError(map.orientFacing).toFixed(1)}°`]);
    out.push(['Gambar di peta', `${map.lines.length} garis · ${map.marks.length} tanda · ${map.strokes.length} coretan`]);
    return out;
  }

  private answerKey(): [string, string][] {
    const { player, sight, w, notebook } = this.h;
    const [ex, ey, ez] = this.h.eye();
    const range = this.h.viewRange();
    const out: [string, string][] = [];
    const visible = new Set(sight.visibleLandmarks(ex, ey, ez, range));
    w.landmarks.forEach((l, id) => {
      const g = azimuthTo(player.x, player.z, l.x, l.z);
      const mag = magneticOf(g);
      const d = M(Math.hypot(l.x - player.x, l.z - player.z));
      out.push([`${visible.has(id) ? '👁 ' : ''}${l.name}`, `az ${deg(mag)} · back ${deg(backAzimuth(Math.round(mag) % 360))} · ${d} m${visible.has(id) ? '' : ' · tak terlihat'}`]);
    });
    notebook.readings.forEach((r, k) => {
      const t = r.target >= 0 ? sight.target(r.target) : undefined;
      const truth = t ? magneticOf(azimuthTo(r.x, r.z, t.x, t.z)) : null;
      const name = r.target < 0 ? 'tidak kena' : w.landmarks[r.target]?.name ?? (r.target === 100 ? 'asap' : `#${r.target}`);
      const pair = r.pairedWith < 0 ? 'belum dipasangkan' : r.pairedWith === r.target ? 'pasangan benar' : 'PASANGAN SALAH';
      out.push([`Bidikan #${k + 1}`, `${deg(r.azimuth)} → ${name}${truth === null ? '' : ` (benar ${deg(truth)}, galat ${angleDiff(r.azimuth, truth).toFixed(1)}°)`} · ${pair}${r.settled ? '' : ' · jarum belum tenang'}`]);
    });
    return out;
  }

  private render() {
    this.posEl.replaceChildren(rows(this.positionRows()));
    this.keyEl.replaceChildren(rows(this.answerKey()));
    const m = this.h.mission();
    if (!m) {
      this.missionEl.replaceChildren(el('p', 'muted', 'Tidak ada misi lapangan aktif.'));
      this.pointsEl.replaceChildren();
      this.pointsKey = '';
    } else {
      const objs = el('div', 'dev-objs', ...m.objectives.map((o, k) => el('div', o.done ? 'ok' : o.optional ? 'muted' : '', `${o.done ? '✓' : '○'} ${k + 1}. ${o.text}${o.optional ? ' (opsional)' : ''}`)));
      this.missionEl.replaceChildren(
        rows([
          ['Level', `${m.level} · waktu ${Math.round(m.time)} s / par ${m.par} s`],
          ['Hasil', m.result ? `${m.result.passed ? 'LULUS' : 'belum lulus'} · skor ${m.result.score}` : 'belum ada'],
          ['Aksi tersedia', m.actions().map((a) => a.label).join(', ') || '—'],
        ]),
        objs,
        rows(m.devInfo()),
      );
      const pts = m.devPoints();
      const key = pts.map((p) => `${p.label}${p.p[0].toFixed(1)}${p.p[1].toFixed(1)}`).join('|');
      if (key !== this.pointsKey) {
        this.pointsKey = key;
        this.pointsEl.replaceChildren(...pts.map(({ label, p }) => {
          const b = el('button', 'btn ghost small', `→ ${label}`);
          b.title = `${p[0].toFixed(1)}, ${p[1].toFixed(1)}`;
          b.addEventListener('click', () => { this.teleport(label, p); b.blur(); });
          return b;
        }));
      }
    }
    this.renderLog();
  }

  private teleport(label: string, p: P) {
    if (!this.h.inField()) return;
    this.h.teleport(p[0] + 0.5, p[1] + 0.5);
    this.add('info', `Teleport ke ${label} (${p[0].toFixed(1)}, ${p[1].toFixed(1)}).`);
  }

  private renderLog() {
    this.logEl.replaceChildren(...this.log.slice(0, 80).map((e) => el('div', `dev-log-${e.level}`, `[${e.t}] ${e.msg}`)));
  }

  // ------------------------------------------------------------------ report

  report() {
    const m = this.h.mission();
    const { player, notebook, map } = this.h;
    return {
      seed: this.h.seed,
      url: location.href,
      userAgent: navigator.userAgent,
      level: m?.level ?? null,
      position: Object.fromEntries(this.positionRows()),
      player: { x: player.x, z: player.z, footY: player.footY, yaw: player.yaw, pitch: player.pitch, flying: player.flying },
      mission: m && {
        time: m.time,
        par: m.par,
        objectives: m.objectives,
        info: Object.fromEntries(m.devInfo()),
        points: m.devPoints(),
        result: m.result,
      },
      readings: notebook.readings,
      notes: notebook.notes,
      map: { lines: map.lines, marks: map.marks, strokes: map.strokes.length },
      answerKey: Object.fromEntries(this.answerKey()),
      log: this.log,
    };
  }

  private async copyReport() {
    const text = JSON.stringify(this.report(), null, 2);
    try {
      await navigator.clipboard.writeText(text);
      this.add('info', 'Laporan disalin ke clipboard.');
    } catch {
      const a = el('a', '');
      a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      a.download = `navigame-bug-${this.h.seed}-L${this.h.mission()?.level ?? 0}.json`;
      a.click();
      this.add('info', 'Clipboard tidak tersedia; laporan diunduh sebagai file.');
    }
  }
}
