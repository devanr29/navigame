// Full-screen topographic map, drawn on a 2D canvas from the same heightmap as the world, with the
// plotting tools from the preparation list: pencil, eraser, point marks, ruler and 360° protractor.
// Core design rule: this view never reads the player's position. There is no "you are here".
// Orienting the map (utarakan peta) is the player's job: they rotate it by hand to match the compass.
import {
  BLOCK_M, CONTOUR_BLOCKS, CONTOUR_M, INDEX_EVERY, KARVAK_SEC, MAP_SCALE, Zone,
  type Landmark, type WorldData,
} from '../gen/constants';
import type { MapLine, MapMark, MapStroke, ToolId } from '../game/state';
import { angleDiff, azimuthTo, norm360 } from '../tools/sight';
import { traceContours, type ContourLine } from './contours';
import { elevationM, fmtDMS, fmtNum, latSecAt, lonSecAt, xAtLonSec, zAtLatSec } from './geo';

const C = {
  desk: '#3b3f44',
  paper: '#fbf8ef',
  forest: [207, 230, 190],
  open: [251, 248, 239],
  water: [166, 208, 240],
  contour: '#b8804a',
  index: '#9a5f2c',
  river: '#2f7fd1',
  trail: '#3a2a1a',
  grid: 'rgba(20, 40, 90, 0.55)',
  ink: '#1d1d1b',
  pencil: '#3d3d46',
  pen: '#1546b8',
  tool: '#d2322d',
};

interface Label { x: number; z: number; a: number; text: string }

/** 'tanda' only exists while a mission asks for a point (destination, own position). */
export type MapTool = 'geser' | 'tanda' | 'pensil' | 'hapus' | 'penggaris' | 'busur' | 'titik';

/** A point on the map shown with a symbol (mission posts with known coordinates). */
export interface MapSymbol { x: number; z: number; label: string; id: number }

/** Shown after a mission step is submitted (the truth, for the debrief). */
export interface Reveal { x: number; z: number; label: string; color: string; from?: [number, number] }

type Request =
  | { kind: 'mark'; prompt: string; done: (x: number, z: number) => void; at: [number, number] | null }
  | { kind: 'symbol'; prompt: string; done: (id: number) => void };

const TOOL_LABEL: Record<MapTool, string> = {
  geser: 'Geser', tanda: 'Tanda', pensil: 'Pensil', hapus: 'Hapus', penggaris: 'Penggaris', busur: 'Busur', titik: 'Titik',
};

export class MapView {
  private ctx: CanvasRenderingContext2D;
  private base: HTMLCanvasElement;
  private normalPath = new Path2D();
  private indexPath = new Path2D();
  private riverPaths: Path2D[] = [];
  private trailPath = new Path2D();
  private labels: Label[] = [];
  private latLines: number[] = [];
  private lonLines: number[] = [];

  // view: screen = R(rot) * zoom * (sheet - centre) + screenCentre
  private cx: number;
  private cz: number;
  private zoom = 1;
  private rot = 0;
  private fitZoom = 1;
  private dpr = 1;
  private dirty = true;
  private pointers = new Map<number, { x: number; y: number; sx: number; sy: number }>();
  private showLegend = false;
  private open = false;
  private placed = false;

  // drawings (sheet coordinates)
  strokes: MapStroke[] = [];
  lines: MapLine[] = [];
  marks: MapMark[] = [];
  private ruler: { ax: number; az: number; bx: number; bz: number } | null = null;
  /** True after "Titik awal" until "Titik akhir": the ruler's end follows the centre crosshair. */
  private rulerLive = false;
  /** Which ruler end a finger is dragging. */
  private rulerEnd: 'a' | 'b' = 'b';
  private protractor: { x: number; z: number; az: number } | null = null;
  private drawing: MapStroke | null = null;
  private gesture: 'none' | 'tool' | 'pinch' | 'pan' | 'busur-move' | 'ruler-end' | 'mark-move' = 'none';
  /** Finger position (canvas px) while a precise placement is under way; the loupe magnifies it. */
  private loupe: { x: number; y: number } | null = null;

  // tools and mission hooks
  private tool: MapTool = 'geser';
  /** Tool in use before a mark request switched to 'tanda'. */
  private toolBefore: MapTool = 'geser';
  private tools = new Set<ToolId>();
  private lockRot = false;
  private request: Request | null = null;
  symbols: MapSymbol[] = [];
  reveals: Reveal[] = [];
  /** Grid azimuth the player faces while the map is open, when the mission asks to show orientation. */
  orientFacing: number | null = null;
  declinationLabel = 'Deklinasi magnetis: 0°';

  // DOM
  private toolbar: HTMLElement;
  private readout: HTMLElement;
  private protBar: HTMLElement;
  private protInput: HTMLInputElement;
  private banner: HTMLElement;
  private bannerText: HTMLElement;
  private bannerOk: HTMLButtonElement;
  private orientEl: HTMLElement;
  private lockBtn: HTMLButtonElement;
  private rulerBar: HTMLElement;
  private rulerEndBtn: HTMLButtonElement;
  private notesEl: HTMLElement;
  private notesOpen = true;
  private notes: string[] = [];
  private toolBtns = new Map<MapTool, HTMLButtonElement>();
  private avail: Record<MapTool, boolean> = { geser: true, tanda: false, pensil: false, hapus: false, penggaris: false, busur: false, titik: false };
  /** Compass reading shown on the map while in the field (null: no compass or not in the field). */
  heading: number | null = null;

  constructor(private canvas: HTMLCanvasElement, private w: WorldData, root: HTMLElement) {
    this.ctx = canvas.getContext('2d')!;
    this.cx = w.size / 2;
    this.cz = w.size / 2;
    this.base = this.buildBase();
    this.buildContours();
    this.buildLines();
    this.buildGrid();

    // ---- tool palette
    this.toolbar = div('map-tools');
    for (const t of Object.keys(TOOL_LABEL) as MapTool[]) {
      const b = button(TOOL_LABEL[t], 'btn ghost small');
      b.addEventListener('click', () => this.setTool(t));
      this.toolBtns.set(t, b);
      this.toolbar.append(b);
    }
    this.lockBtn = button('Kunci arah', 'btn ghost small');
    this.lockBtn.addEventListener('click', () => {
      this.lockRot = !this.lockRot;
      this.lockBtn.classList.toggle('on', this.lockRot);
    });
    this.toolbar.append(this.lockBtn);
    this.readout = div('map-readout');
    this.readout.hidden = true;

    this.protBar = div('prot-bar');
    this.protBar.hidden = true;
    const minus = button('−1°', 'btn ghost small');
    minus.addEventListener('click', () => this.nudgeProtractor(-1));
    const plus = button('+1°', 'btn ghost small');
    plus.addEventListener('click', () => this.nudgeProtractor(1));
    this.protInput = document.createElement('input');
    this.protInput.type = 'number';
    this.protInput.inputMode = 'decimal';
    this.protInput.step = '0.5';
    this.protInput.min = '0';
    this.protInput.max = '360';
    this.protInput.className = 'prot-input';
    this.protInput.addEventListener('input', () => {
      const v = parseFloat(this.protInput.value.replace(',', '.'));
      if (this.protractor && Number.isFinite(v)) {
        this.protractor.az = norm360(v);
        this.dirty = true;
      }
    });
    const drawBtn = button('Gariskan', 'btn small');
    drawBtn.addEventListener('click', () => this.drawProtractorLine());
    this.protBar.append(minus, this.protInput, plus, drawBtn);

    this.banner = div('map-banner');
    this.banner.hidden = true;
    this.bannerText = div('');
    this.bannerOk = button('Kirim', 'btn small');
    this.bannerOk.addEventListener('click', () => this.confirmRequest());
    const cancel = button('Batal', 'btn ghost small');
    cancel.addEventListener('click', () => this.cancelRequest());
    this.banner.append(this.bannerText, this.bannerOk, cancel);

    this.orientEl = div('map-orient');
    this.orientEl.hidden = true;

    // Ruler on a phone: pan the map so a point sits under the centre crosshair, then press a button.
    // A fingertip is too wide to drop the ends exactly by dragging.
    this.rulerBar = div('prot-bar');
    this.rulerBar.hidden = true;
    const startBtn = button('Titik awal', 'btn small');
    startBtn.addEventListener('click', () => this.setRulerStart());
    this.rulerEndBtn = button('Titik akhir', 'btn small');
    this.rulerEndBtn.addEventListener('click', () => this.setRulerEnd());
    this.rulerBar.append(startBtn, this.rulerEndBtn);

    // Field notebook entries that are ready to draw (paired, back azimuth written).
    this.notesEl = div('map-notes');
    this.notesEl.hidden = true;

    // Bottom-left dock: a pending request above the tool palette, so neither covers the other.
    const dock = div('map-dock');
    dock.append(this.banner, this.toolbar);
    root.append(dock, this.readout, this.protBar, this.rulerBar, this.orientEl, this.notesEl);

    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => {
      if (!this.open || e.target instanceof HTMLInputElement) return;
      if (e.code === 'KeyQ') this.rotateBy(-0.08);
      if (e.code === 'KeyE') this.rotateBy(0.08);
    });
    window.addEventListener('resize', () => this.resize());
    const loop = () => {
      if (this.open && this.dirty) this.draw();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    this.setTools(new Set());
  }

  // ------------------------------------------------------------------ public API

  /** Opens the map. Like a paper map, it keeps the zoom, pan and rotation it had when it was put away. */
  show() {
    this.open = true;
    this.resize();
    if (!this.placed) {
      this.placed = true;
      this.zoom = this.fitZoom;
      this.cx = this.w.size / 2;
      this.cz = this.w.size / 2 + 26 / this.zoom;
    }
    this.updateOrient();
  }

  hide() {
    this.open = false;
    this.pointers.clear();
    this.gesture = 'none';
    this.drawing = null;
    this.loupe = null;
  }

  isOpen() { return this.open; }

  toggleLegend() {
    this.showLegend = !this.showLegend;
    this.dirty = true;
  }

  northUp() {
    if (this.lockRot) return;
    this.rot = 0;
    this.dirty = true;
    this.updateOrient();
  }

  /** Map rotation as a compass angle: degrees the sheet's north is turned clockwise on screen. */
  rotationDeg() { return norm360((this.rot * 180) / Math.PI); }

  /**
   * How far the map is from being oriented, in degrees, given the grid azimuth the player faces.
   * Oriented = sheet north on screen points to real north, which lies `facing` degrees to the left.
   */
  orientationError(facing: number): number {
    return angleDiff(this.rotationDeg(), -facing);
  }

  /** Which tools were packed. The palette only offers what the player brought. */
  setTools(tools: Set<ToolId>) {
    this.tools = tools;
    const canDraw = tools.has('pensil') || tools.has('pena');
    const avail: Record<MapTool, boolean> = {
      geser: true,
      tanda: this.request?.kind === 'mark',
      pensil: canDraw,
      hapus: tools.has('penghapus'),
      penggaris: tools.has('penggaris'),
      busur: tools.has('busur'),
      titik: canDraw,
    };
    this.avail = avail;
    for (const [t, b] of this.toolBtns) b.hidden = !avail[t];
    this.lockBtn.hidden = !tools.has('papan');
    if (!tools.has('papan')) this.lockRot = false;
    if (!avail[this.tool]) this.setTool('geser');
  }

  /** Removes all drawings, marks, symbols and reveals (new mission). */
  resetSheet() {
    this.strokes = [];
    this.lines = [];
    this.marks = [];
    this.ruler = null;
    this.protractor = null;
    this.symbols = [];
    this.reveals = [];
    this.request = null;
    this.banner.hidden = true;
    this.setTools(this.tools);
    this.rulerLive = false;
    this.notes = [];
    this.renderNotes();
    this.rot = 0;
    this.placed = false;
    this.lockRot = false;
    this.lockBtn.classList.remove('on');
    this.setTool('geser');
    this.dirty = true;
  }

  /** Asks the player to place a point on the map and press Kirim. */
  requestMark(prompt: string, done: (x: number, z: number) => void) {
    this.request = { kind: 'mark', prompt, done, at: null };
    // The packed tools stay available (ruler, protractor, pencil) to work the point out; the
    // 'tanda' tool places the point itself.
    if (this.tool !== 'tanda') this.toolBefore = this.tool;
    this.setTools(this.tools);
    this.setTool('tanda');
    this.showBanner(prompt, true);
  }

  /** Asks the player to tap a symbol (landmark or mission post). */
  requestSymbol(prompt: string, done: (id: number) => void) {
    this.request = { kind: 'symbol', prompt, done };
    this.showBanner(prompt, false);
  }

  hasRequest() { return this.request !== null; }

  redraw() {
    this.dirty = true;
    this.updateOrient();
  }

  /** Lines shown in the notes panel on the map (empty hides it). */
  setNotes(lines: string[]) {
    this.notes = lines;
    this.renderNotes();
  }

  private renderNotes() {
    this.notesEl.hidden = this.notes.length === 0;
    const head = button(`Catatan (${this.notes.length}) ${this.notesOpen ? '▾' : '▸'}`, 'map-notes-head');
    head.addEventListener('click', () => {
      this.notesOpen = !this.notesOpen;
      this.renderNotes();
    });
    // The list scrolls inside the panel, so any number of readings fits.
    const list = div('map-notes-list');
    list.hidden = !this.notesOpen;
    for (const n of this.notes) {
      const row = div('');
      row.textContent = n;
      list.append(row);
    }
    this.notesEl.replaceChildren(head, list);
  }

  /** Sheet point under the centre crosshair, snapped to a nearby symbol or mark. */
  private centrePoint(): [number, number] {
    return this.snap(this.cx, this.cz);
  }

  private setRulerStart() {
    const [x, z] = this.centrePoint();
    this.ruler = { ax: x, az: z, bx: x, bz: z };
    this.rulerLive = true;
    this.updateReadout();
    this.syncChrome();
    this.dirty = true;
  }

  private setRulerEnd() {
    if (!this.ruler) return;
    const [x, z] = this.centrePoint();
    this.ruler.bx = x;
    this.ruler.bz = z;
    this.rulerLive = false;
    this.updateReadout();
    this.syncChrome();
    this.dirty = true;
  }

  /** Shows only the controls that make sense right now. A pending request hides the tools. */
  private syncChrome() {
    // A symbol request only needs a tap on a symbol, so it hides the tools; a mark request keeps them.
    const req = this.request?.kind === 'symbol';
    this.toolbar.hidden = req;
    this.protBar.hidden = req || this.tool !== 'busur';
    this.rulerBar.hidden = req || this.tool !== 'penggaris';
    this.rulerEndBtn.disabled = !this.ruler || !this.rulerLive;
    this.readout.hidden = req || !(this.tool === 'busur' || this.tool === 'penggaris');
  }

  private writeTool(): 'pensil' | 'pena' | null {
    return this.tools.has('pensil') ? 'pensil' : this.tools.has('pena') ? 'pena' : null;
  }

  private setTool(t: MapTool) {
    this.tool = t;
    for (const [k, b] of this.toolBtns) b.classList.toggle('on', k === t);
    this.syncChrome();
    this.updateReadout();
    this.dirty = true;
  }

  private showBanner(text: string, needsOk: boolean) {
    this.bannerText.textContent = text;
    this.bannerOk.hidden = !needsOk;
    this.bannerOk.disabled = needsOk;
    this.banner.hidden = false;
    this.syncChrome();
    this.dirty = true;
  }

  private endRequest() {
    const wasMark = this.request?.kind === 'mark';
    this.request = null;
    this.banner.hidden = true;
    if (wasMark) {
      this.setTools(this.tools);
      this.setTool(this.avail[this.toolBefore] ? this.toolBefore : 'geser');
    }
    this.syncChrome();
    this.dirty = true;
  }

  private confirmRequest() {
    const r = this.request;
    if (!r || r.kind !== 'mark' || !r.at) return;
    this.endRequest();
    r.done(r.at[0], r.at[1]);
  }

  /** Called when the player cancels a mark/symbol request. */
  onRequestCancel: () => void = () => {};

  cancelRequest() {
    if (!this.request) return;
    this.endRequest();
    this.onRequestCancel();
  }

  private updateOrient() {
    const head = this.heading === null ? null : `Kompas ${String(Math.round(this.heading) % 360).padStart(3, '0')}°`;
    if (this.orientFacing === null) {
      this.orientEl.hidden = head === null;
      this.orientEl.textContent = head ?? '';
      this.orientEl.classList.remove('ok');
      return;
    }
    const err = this.orientationError(this.orientFacing);
    this.orientEl.hidden = false;
    const ok = Math.abs(err) <= 5;
    const state = ok
      ? `Peta sudah diutarakan (selisih ${Math.abs(Math.round(err))}°)`
      : `Peta melenceng ${Math.abs(Math.round(err))}° — putar peta dengan dua jari`;
    this.orientEl.textContent = head ? `${head} · ${state}` : state;
    this.orientEl.classList.toggle('ok', ok);
  }

  private updateReadout() {
    if (this.tool === 'penggaris') {
      if (!this.ruler) this.readout.textContent = 'Geser peta: taruh titik di tanda + lalu tekan Titik awal';
      else {
        const blocks = Math.hypot(this.ruler.bx - this.ruler.ax, this.ruler.bz - this.ruler.az);
        this.readout.textContent = `Penggaris: ${fmtCm(blocks)} cm = ${fmtNum(Math.round(blocks * BLOCK_M))} m di medan`;
      }
    } else if (this.tool === 'busur') {
      if (!this.protractor) this.readout.textContent = 'Ketuk titik untuk meletakkan busur';
      else this.readout.textContent = `Busur: ${fmtNum(Math.round(this.protractor.az * 2) / 2)}° dari utara peta`;
    }
  }

  private nudgeProtractor(d: number) {
    if (!this.protractor) return;
    this.protractor.az = norm360(Math.round(this.protractor.az) + d);
    this.protInput.value = String(this.protractor.az);
    this.updateReadout();
    this.dirty = true;
  }

  private drawProtractorLine() {
    const p = this.protractor;
    const wt = this.writeTool();
    if (!p || !wt) return;
    this.lines.push({ x: p.x, z: p.z, az: p.az, len: this.w.size * 1.5, pen: wt === 'pena' });
    this.dirty = true;
  }

  // ------------------------------------------------------------------ preparation

  private buildBase(): HTMLCanvasElement {
    const N = this.w.size;
    const cv = document.createElement('canvas');
    cv.width = N;
    cv.height = N;
    const g = cv.getContext('2d')!;
    const img = g.createImageData(N, N);
    for (let i = 0; i < N * N; i++) {
      const c = this.w.water[i] >= 0 ? C.water : this.w.zone[i] === Zone.Forest ? C.forest : C.open;
      img.data[i * 4] = c[0];
      img.data[i * 4 + 1] = c[1];
      img.data[i * 4 + 2] = c[2];
      img.data[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return cv;
  }

  private buildContours() {
    const lines = traceContours(this.w.heightF, this.w.size, CONTOUR_BLOCKS, INDEX_EVERY);
    for (const l of lines) {
      const p = l.index ? this.indexPath : this.normalPath;
      addPoly(p, l.pts);
      if (l.index) this.addContourLabels(l);
    }
  }

  private addContourLabels(l: ContourLine) {
    const pts = l.pts;
    let total = 0;
    for (let k = 2; k < pts.length; k += 2) total += Math.hypot(pts[k] - pts[k - 2], pts[k + 1] - pts[k - 1]);
    if (total < 160) return;
    const text = fmtNum(elevationM(l.level));
    let acc = 0;
    let next = 70;
    for (let k = 2; k < pts.length; k += 2) {
      acc += Math.hypot(pts[k] - pts[k - 2], pts[k + 1] - pts[k - 1]);
      if (acc >= next && k + 6 < pts.length) {
        const a = Math.atan2(pts[k + 7] - pts[k - 1], pts[k + 6] - pts[k - 2]);
        this.labels.push({ x: pts[k], z: pts[k + 1], a, text });
        next += 320;
      }
    }
  }

  private buildLines() {
    for (const r of this.w.rivers) {
      const p = new Path2D();
      addPoly(p, r);
      this.riverPaths.push(p);
    }
    for (const t of this.w.trails) addPoly(this.trailPath, t);
  }

  private buildGrid() {
    const N = this.w.size;
    const s0 = latSecAt(0), s1 = latSecAt(N);
    for (let s = Math.ceil(s0 / KARVAK_SEC) * KARVAK_SEC; s < s1; s += KARVAK_SEC) this.latLines.push(s);
    const l0 = lonSecAt(0), l1 = lonSecAt(N);
    for (let s = Math.ceil(l0 / KARVAK_SEC) * KARVAK_SEC; s < l1; s += KARVAK_SEC) this.lonLines.push(s);
  }

  /** Karvak name (e.g. "C4") of a sheet point. */
  karvakAt(x: number, z: number): string {
    const xs = this.lonLines.map(xAtLonSec);
    const zs = this.latLines.map(zAtLatSec);
    const col = xs.filter((v) => v <= x).length;
    const row = zs.filter((v) => v <= z).length;
    return `${String.fromCharCode(65 + col)}${row + 1}`;
  }

  /** All karvak names on the sheet. */
  karvakNames(): string[] {
    const out: string[] = [];
    for (let c = 0; c <= this.lonLines.length; c++) {
      for (let r = 0; r <= this.latLines.length; r++) out.push(`${String.fromCharCode(65 + c)}${r + 1}`);
    }
    return out;
  }

  // ------------------------------------------------------------------ drawing

  private resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(r.width * this.dpr);
    this.canvas.height = Math.round(r.height * this.dpr);
    const N = this.w.size;
    const k = Math.abs(Math.cos(this.rot)) + Math.abs(Math.sin(this.rot));
    this.fitZoom = Math.min((r.width - 130) / (N * k), (r.height - 175) / (N * k));
    this.dirty = true;
  }

  private draw() {
    this.dirty = false;
    if (this.rulerLive && this.ruler && this.tool === 'penggaris') {
      [this.ruler.bx, this.ruler.bz] = this.centrePoint();
      this.updateReadout();
    }
    const ctx = this.ctx;
    const W = this.canvas.width / this.dpr;
    const H = this.canvas.height / this.dpr;
    const N = this.w.size;
    const z = this.zoom;
    const m = 1 / z; // sheet units per screen px

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = C.desk;
    ctx.fillRect(0, 0, W, H);

    ctx.translate(W / 2, H / 2);
    ctx.rotate(this.rot);
    ctx.scale(z, z);
    ctx.translate(-this.cx, -this.cz);

    const mL = 50 * m, mT = 46 * m, mB = 98 * m;
    ctx.fillStyle = C.paper;
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = 12;
    ctx.fillRect(-mL, -mT, N + 2 * mL, N + mT + mB);
    ctx.shadowBlur = 0;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, N, N);
    ctx.clip();
    ctx.imageSmoothingEnabled = z < 3;
    ctx.drawImage(this.base, 0, 0);

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = C.contour;
    ctx.lineWidth = 0.7 * m;
    ctx.stroke(this.normalPath);
    ctx.strokeStyle = C.index;
    ctx.lineWidth = 1.5 * m;
    ctx.stroke(this.indexPath);

    ctx.strokeStyle = C.river;
    this.riverPaths.forEach((p, k) => {
      ctx.lineWidth = Math.max(k === 0 ? 2.2 * m : 1.4 * m, k === 0 ? 4 : 2);
      ctx.stroke(p);
    });

    ctx.strokeStyle = C.trail;
    ctx.lineWidth = 1.3 * m;
    ctx.setLineDash([5 * m, 3 * m]);
    ctx.stroke(this.trailPath);
    ctx.setLineDash([]);

    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 0.8 * m;
    ctx.beginPath();
    for (const s of this.latLines) { const y = zAtLatSec(s); ctx.moveTo(0, y); ctx.lineTo(N, y); }
    for (const s of this.lonLines) { const x = xAtLonSec(s); ctx.moveTo(x, 0); ctx.lineTo(x, N); }
    ctx.stroke();

    ctx.font = '600 9px system-ui, sans-serif';
    for (const lb of this.labels) {
      let a = lb.a;
      const screenA = a + this.rot;
      const nrm = Math.atan2(Math.sin(screenA), Math.cos(screenA));
      if (nrm > Math.PI / 2 || nrm < -Math.PI / 2) a += Math.PI;
      this.text(lb.x, lb.z, lb.text, C.index, a, m, true);
    }

    this.drawKarvakNames(m);
    this.drawUserLayer(m);
    ctx.restore();
    for (const l of this.w.landmarks) this.drawLandmark(l, m);
    for (const s of this.symbols) this.drawPost(s, m);

    ctx.strokeStyle = C.ink;
    ctx.lineWidth = 1.2 * m;
    ctx.strokeRect(0, 0, N, N);

    this.drawMargins(m);
    this.drawToolOverlays(m);
    this.drawReveals(m);

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (this.tool === 'penggaris' && this.request?.kind !== 'symbol') this.drawCrosshair(W / 2, H / 2);
    if (this.loupe) this.drawLoupe(this.loupe.x, this.loupe.y, W);
    if (this.showLegend) this.drawLegend(W, H);
  }

  /** Fixed crosshair at the screen centre: the ruler buttons drop an end here. */
  private drawCrosshair(x: number, y: number) {
    const ctx = this.ctx;
    for (const [col, w] of [['#ffffff', 4], [C.tool, 2]] as [string, number][]) {
      ctx.strokeStyle = col;
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(x - 16, y); ctx.lineTo(x - 5, y);
      ctx.moveTo(x + 5, y); ctx.lineTo(x + 16, y);
      ctx.moveTo(x, y - 16); ctx.lineTo(x, y - 5);
      ctx.moveTo(x, y + 5); ctx.lineTo(x, y + 16);
      ctx.stroke();
    }
  }

  /**
   * Magnifier above the fingertip (canvas px), so the player sees exactly what is under the finger.
   * It copies the just-drawn frame from this same canvas, which costs one image draw.
   */
  private drawLoupe(fx: number, fy: number, W: number) {
    const ctx = this.ctx;
    const R = 58, MAG = 2.4, GAP = 104;
    let lx = fx, ly = fy - GAP;
    if (ly - R < 4) { ly = fy; lx = fx + (fx < W / 2 ? GAP : -GAP); }
    const src = (2 * R) / MAG;
    const d = this.dpr;
    ctx.save();
    ctx.beginPath();
    ctx.arc(lx, ly, R, 0, Math.PI * 2);
    ctx.fillStyle = C.desk;
    ctx.fill();
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.canvas, (fx - src / 2) * d, (fy - src / 2) * d, src * d, src * d, lx - R, ly - R, 2 * R, 2 * R);
    ctx.restore();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(lx, ly, R, 0, Math.PI * 2);
    ctx.stroke();
    this.drawCrosshair(lx, ly);
  }

  private drawUserLayer(m: number) {
    const ctx = this.ctx;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const s of this.strokes) {
      ctx.strokeStyle = s.pen ? C.pen : C.pencil;
      ctx.lineWidth = 1.6 * m;
      const p = new Path2D();
      addPoly(p, s.pts);
      ctx.stroke(p);
    }
    for (const l of this.lines) {
      ctx.strokeStyle = l.pen ? C.pen : C.pencil;
      ctx.lineWidth = 1.3 * m;
      const r = (l.az * Math.PI) / 180;
      ctx.beginPath();
      ctx.moveTo(l.x, l.z);
      ctx.lineTo(l.x + Math.sin(r) * l.len, l.z - Math.cos(r) * l.len);
      ctx.stroke();
    }
    ctx.font = '700 10px system-ui, sans-serif';
    for (const k of this.marks) {
      ctx.strokeStyle = k.pen ? C.pen : C.pencil;
      ctx.lineWidth = 1.8 * m;
      const s = 5 * m;
      ctx.beginPath();
      ctx.moveTo(k.x - s, k.z - s); ctx.lineTo(k.x + s, k.z + s);
      ctx.moveTo(k.x + s, k.z - s); ctx.lineTo(k.x - s, k.z + s);
      ctx.stroke();
      this.text(k.x + 7 * m, k.z - 7 * m, k.label, k.pen ? C.pen : C.pencil, 0, m, true, 'left');
    }
  }

  private drawToolOverlays(m: number) {
    const ctx = this.ctx;
    if (this.ruler && this.tool === 'penggaris') {
      const r = this.ruler;
      ctx.strokeStyle = C.tool;
      ctx.lineWidth = 2 * m;
      ctx.beginPath();
      ctx.moveTo(r.ax, r.az);
      ctx.lineTo(r.bx, r.bz);
      ctx.stroke();
      for (const [x, zz] of [[r.ax, r.az], [r.bx, r.bz]]) {
        ctx.beginPath();
        ctx.arc(x, zz, 3 * m, 0, Math.PI * 2);
        ctx.stroke();
      }
      const blocks = Math.hypot(r.bx - r.ax, r.bz - r.az);
      ctx.font = '700 12px system-ui, sans-serif';
      this.text((r.ax + r.bx) / 2, (r.az + r.bz) / 2 - 10 * m, `${fmtCm(blocks)} cm`, C.tool, 0, m, true);
    }
    if (this.protractor && this.tool === 'busur') {
      const p = this.protractor;
      ctx.save();
      ctx.translate(p.x, p.z);
      ctx.scale(m, m);
      const R = 74;
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.strokeStyle = C.tool;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(0, 0, R, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.font = '600 9px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = C.tool;
      for (let d = 0; d < 360; d += 5) {
        const a = (d * Math.PI) / 180;
        const len = d % 30 === 0 ? 12 : d % 10 === 0 ? 8 : 4;
        ctx.beginPath();
        ctx.moveTo(Math.sin(a) * R, -Math.cos(a) * R);
        ctx.lineTo(Math.sin(a) * (R - len), -Math.cos(a) * (R - len));
        ctx.stroke();
        if (d % 30 === 0) ctx.fillText(String(d), Math.sin(a) * (R - 22), -Math.cos(a) * (R - 22));
      }
      const a = (p.az * Math.PI) / 180;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.sin(a) * (R + 40), -Math.cos(a) * (R + 40));
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    if (this.request?.kind === 'mark' && this.request.at) {
      const [x, zz] = this.request.at;
      ctx.strokeStyle = C.tool;
      ctx.lineWidth = 2.2 * m;
      ctx.beginPath();
      ctx.arc(x, zz, 7 * m, 0, Math.PI * 2);
      ctx.moveTo(x - 11 * m, zz); ctx.lineTo(x + 11 * m, zz);
      ctx.moveTo(x, zz - 11 * m); ctx.lineTo(x, zz + 11 * m);
      ctx.stroke();
    }
  }

  private drawReveals(m: number) {
    const ctx = this.ctx;
    ctx.font = '700 11px system-ui, sans-serif';
    for (const r of this.reveals) {
      ctx.strokeStyle = r.color;
      ctx.fillStyle = r.color;
      ctx.lineWidth = 2 * m;
      if (r.from) {
        ctx.setLineDash([4 * m, 3 * m]);
        ctx.beginPath();
        ctx.moveTo(r.from[0], r.from[1]);
        ctx.lineTo(r.x, r.z);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.beginPath();
      ctx.arc(r.x, r.z, 6 * m, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(r.x, r.z, 2 * m, 0, Math.PI * 2);
      ctx.fill();
      this.text(r.x + 9 * m, r.z + 9 * m, r.label, r.color, 0, m, true, 'left');
    }
  }

  private drawPost(s: MapSymbol, m: number) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(s.x, s.z);
    ctx.scale(m, m);
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = C.ink;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = C.ink;
    ctx.beginPath();
    ctx.arc(0, 0, 1.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.font = '700 10px system-ui, sans-serif';
    this.text(s.x + 8 * m, s.z, s.label, C.ink, 0, m, true, 'left');
  }

  private text(
    x: number, z: number, s: string, color: string, a: number, m: number, halo = false,
    align: CanvasTextAlign = 'center', baseline: CanvasTextBaseline = 'middle',
  ) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, z);
    ctx.rotate(a);
    ctx.scale(m, m);
    ctx.textAlign = align;
    ctx.textBaseline = baseline;
    if (halo) {
      ctx.strokeStyle = C.paper;
      ctx.lineWidth = 3;
      ctx.strokeText(s, 0, 0);
    }
    ctx.fillStyle = color;
    ctx.fillText(s, 0, 0);
    ctx.restore();
  }

  private drawLandmark(l: Landmark, m: number) {
    const ctx = this.ctx;
    ctx.font = '500 9px system-ui, sans-serif';
    if (l.kind === 'bridge' && l.dir) {
      const [dx, dz] = l.dir;
      const px = -dz, pz = dx;
      const L = l.halfLen! + 1.5;
      ctx.strokeStyle = C.ink;
      ctx.lineWidth = 1.4 * m;
      ctx.beginPath();
      for (const s of [-1, 1]) {
        const off = s * Math.max(1.6, 3 * m);
        const fl = s * Math.max(1.2, 3 * m);
        ctx.moveTo(l.x - dx * L + px * (off + fl) - dx * fl, l.z - dz * L + pz * (off + fl) - dz * fl);
        ctx.lineTo(l.x - dx * L + px * off, l.z - dz * L + pz * off);
        ctx.lineTo(l.x + dx * L + px * off, l.z + dz * L + pz * off);
        ctx.lineTo(l.x + dx * L + px * (off + fl) + dx * fl, l.z + dz * L + pz * (off + fl) + dz * fl);
      }
      ctx.stroke();
      this.text(l.x + px * 16 * m, l.z + pz * 16 * m + 10 * m, l.name, C.ink, 0, m, true, 'left');
      return;
    }
    ctx.save();
    ctx.translate(l.x, l.z);
    ctx.scale(m, m);
    ctx.fillStyle = C.ink;
    ctx.strokeStyle = C.ink;
    ctx.lineWidth = 1.3;
    drawSymbol(ctx, l.kind);
    ctx.restore();
    const label = l.kind === 'peak' ? `${l.name} ${fmtNum(elevationM(l.y))}` : l.name;
    this.text(l.x + 9 * m, l.z, label, C.ink, 0, m, true, 'left');
  }

  private drawKarvakNames(m: number) {
    const N = this.w.size;
    this.ctx.font = '700 10px system-ui, sans-serif';
    const xs = [0, ...this.lonLines.map(xAtLonSec), N];
    const zs = [0, ...this.latLines.map(zAtLatSec), N];
    for (let c = 0; c < xs.length - 1; c++) {
      this.text((xs[c] + xs[c + 1]) / 2, 8 * m, String.fromCharCode(65 + c), C.grid, 0, m, true);
    }
    for (let r = 0; r < zs.length - 1; r++) {
      this.text(8 * m, (zs[r] + zs[r + 1]) / 2, String(r + 1), C.grid, 0, m, true);
    }
  }

  private drawMargins(m: number) {
    const ctx = this.ctx;
    const N = this.w.size;
    ctx.font = '500 9px system-ui, sans-serif';
    for (const s of this.latLines) {
      const y = zAtLatSec(s);
      const t = fmtDMS(s, false);
      this.text(-4 * m, y, t, C.ink, 0, m, false, 'right');
      this.text(N + 4 * m, y, t, C.ink, 0, m, false, 'left');
      ctx.lineWidth = m;
      ctx.strokeStyle = C.ink;
      ctx.beginPath();
      ctx.moveTo(-3 * m, y); ctx.lineTo(0, y);
      ctx.moveTo(N, y); ctx.lineTo(N + 3 * m, y);
      ctx.stroke();
    }
    for (const s of this.lonLines) {
      const x = xAtLonSec(s);
      const t = fmtDMS(s, false);
      this.text(x, -5 * m, t, C.ink, 0, m, false, 'center', 'bottom');
      this.text(x, N + 5 * m, t, C.ink, 0, m, false, 'center', 'top');
      ctx.beginPath();
      ctx.moveTo(x, -3 * m); ctx.lineTo(x, 0);
      ctx.moveTo(x, N); ctx.lineTo(x, N + 3 * m);
      ctx.stroke();
    }

    ctx.font = '700 11px system-ui, sans-serif';
    this.text(N / 2, -26 * m, 'PETA TOPOGRAFI  ·  LATIHAN NAVIGASI DARAT', C.ink, 0, m, false, 'center', 'middle');

    const km = 1000 / BLOCK_M;
    const y0 = N + 26 * m;
    const bh = 5 * m;
    for (let k = 0; k < 4; k++) {
      ctx.fillStyle = k % 2 ? C.paper : C.ink;
      ctx.fillRect((k * km) / 4, y0, km / 4, bh);
    }
    ctx.strokeStyle = C.ink;
    ctx.lineWidth = m;
    ctx.strokeRect(0, y0, km, bh);
    ctx.font = '500 9px system-ui, sans-serif';
    this.text(0, y0 + bh + 3 * m, '0', C.ink, 0, m, false, 'center', 'top');
    this.text(km / 2, y0 + bh + 3 * m, '500 m', C.ink, 0, m, false, 'center', 'top');
    this.text(km, y0 + bh + 3 * m, '1 km', C.ink, 0, m, false, 'center', 'top');
    ctx.font = '700 10px system-ui, sans-serif';
    this.text(km + 14 * m, y0 + bh / 2, `SKALA 1:${MAP_SCALE.toLocaleString('id-ID')}`, C.ink, 0, m, false, 'left');
    ctx.font = '500 9px system-ui, sans-serif';
    this.text(km + 14 * m, y0 + bh / 2 + 13 * m, `Interval kontur ${fmtNum(CONTOUR_M)} m · karvak ${KARVAK_SEC}″`, C.ink, 0, m, false, 'left');
    this.text(km + 14 * m, y0 + bh / 2 + 26 * m, this.declinationLabel, C.ink, 0, m, false, 'left');
    const deg = (sec: number) => Math.floor(sec / 3600);
    this.text(0, y0 + bh + 44 * m,
      `Label tepi = menit′detik″. Lintang ${deg(latSecAt(0))}° LS, bujur ${deg(lonSecAt(0))}° BT.`,
      C.ink, 0, m, false, 'left', 'top');

    ctx.save();
    ctx.translate(N + 26 * m, -12 * m);
    ctx.scale(m, m);
    ctx.fillStyle = C.ink;
    ctx.beginPath();
    ctx.moveTo(0, -22); ctx.lineTo(7, 4); ctx.lineTo(0, -2); ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(0, -22); ctx.lineTo(-7, 4); ctx.lineTo(0, -2); ctx.closePath();
    ctx.strokeStyle = C.ink;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.font = '700 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText('U', 0, -24);
    ctx.restore();
  }

  private drawLegend(W: number, H: number) {
    const ctx = this.ctx;
    const items: [string, (c: CanvasRenderingContext2D) => void][] = [
      ['Puncak + tinggi (m)', (c) => drawSymbol(c, 'peak')],
      ['Menara radio', (c) => drawSymbol(c, 'tower')],
      ['Pondok', (c) => drawSymbol(c, 'hut')],
      ['Jembatan', (c) => { c.beginPath(); c.moveTo(-9, -6); c.lineTo(-6, -3); c.lineTo(6, -3); c.lineTo(9, -6); c.moveTo(-9, 6); c.lineTo(-6, 3); c.lineTo(6, 3); c.lineTo(9, 6); c.stroke(); }],
      ['Pohon tunggal', (c) => drawSymbol(c, 'lonetree')],
      ['Tugu', (c) => drawSymbol(c, 'monument')],
      ['Pos / patok (koordinat diketahui)', (c) => { c.fillStyle = '#fff'; c.beginPath(); c.arc(0, 0, 4.5, 0, Math.PI * 2); c.fill(); c.stroke(); }],
      ['Jalan setapak', (c) => { c.setLineDash([5, 3]); c.strokeStyle = C.trail; c.beginPath(); c.moveTo(-10, 0); c.lineTo(10, 0); c.stroke(); c.setLineDash([]); }],
      ['Sungai', (c) => { c.strokeStyle = C.river; c.lineWidth = 3; c.beginPath(); c.moveTo(-10, 2); c.quadraticCurveTo(0, -4, 10, 2); c.stroke(); }],
      ['Hutan lebat', (c) => { c.fillStyle = `rgb(${C.forest.join(',')})`; c.fillRect(-10, -6, 20, 12); c.strokeRect(-10, -6, 20, 12); }],
      [`Kontur (${fmtNum(CONTOUR_M)} m)`, (c) => { c.strokeStyle = C.contour; c.lineWidth = 0.8; c.beginPath(); c.moveTo(-10, 0); c.lineTo(10, 0); c.stroke(); }],
      [`Kontur indeks (${fmtNum(CONTOUR_M * INDEX_EVERY)} m)`, (c) => { c.strokeStyle = C.index; c.lineWidth = 1.8; c.beginPath(); c.moveTo(-10, 0); c.lineTo(10, 0); c.stroke(); }],
      [`Garis karvak (${KARVAK_SEC}″)`, (c) => { c.strokeStyle = C.grid; c.beginPath(); c.moveTo(-10, 0); c.lineTo(10, 0); c.stroke(); }],
      [this.declinationLabel, () => {}],
    ];
    const rowH = 19;
    const bw = 250, bh = items.length * rowH + 34;
    const x0 = W - bw - 12;
    const y0 = Math.max(56, Math.min(H - bh - 8, (H - bh) / 2));
    ctx.fillStyle = 'rgba(251, 248, 239, 0.97)';
    ctx.strokeStyle = C.ink;
    ctx.lineWidth = 1;
    ctx.fillRect(x0, y0, bw, bh);
    ctx.strokeRect(x0, y0, bw, bh);
    ctx.fillStyle = C.ink;
    ctx.font = '700 12px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('LEGENDA', x0 + 12, y0 + 16);
    ctx.font = '500 11px system-ui, sans-serif';
    items.forEach(([label, sym], k) => {
      const y = y0 + 36 + k * rowH;
      ctx.save();
      ctx.translate(x0 + 24, y);
      ctx.fillStyle = C.ink;
      ctx.strokeStyle = C.ink;
      ctx.lineWidth = 1.3;
      sym(ctx);
      ctx.restore();
      ctx.fillStyle = C.ink;
      ctx.fillText(label, x0 + 46, y);
    });
  }

  // ------------------------------------------------------------------ gestures

  private screenToSheet(sx: number, sy: number): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    const dx = sx - r.left - r.width / 2;
    const dy = sy - r.top - r.height / 2;
    const c = Math.cos(-this.rot), s = Math.sin(-this.rot);
    return [this.cx + (dx * c - dy * s) / this.zoom, this.cz + (dx * s + dy * c) / this.zoom];
  }

  private pin(wx: number, wz: number, sx: number, sy: number) {
    const r = this.canvas.getBoundingClientRect();
    const dx = sx - r.left - r.width / 2;
    const dy = sy - r.top - r.height / 2;
    const c = Math.cos(-this.rot), s = Math.sin(-this.rot);
    this.cx = wx - (dx * c - dy * s) / this.zoom;
    this.cz = wz - (dx * s + dy * c) / this.zoom;
    this.clampView();
  }

  private clampView() {
    const N = this.w.size;
    this.cx = Math.max(-60, Math.min(N + 60, this.cx));
    this.cz = Math.max(-60, Math.min(N + 100, this.cz));
    this.dirty = true;
  }

  private setZoom(z: number) {
    this.zoom = Math.max(this.fitZoom * 0.6, Math.min(30, z));
  }

  private rotateBy(a: number) {
    if (this.lockRot) return;
    const r = this.canvas.getBoundingClientRect();
    const mid: [number, number] = [r.left + r.width / 2, r.top + r.height / 2];
    const [wx, wz] = this.screenToSheet(mid[0], mid[1]);
    this.rot += a;
    this.pin(wx, wz, mid[0], mid[1]);
    this.updateOrient();
  }

  /** Snaps a sheet point to the nearest symbol or mark within 18 screen px. */
  private snap(x: number, z: number): [number, number] {
    const lim = 18 / this.zoom;
    let best: [number, number] = [x, z];
    let bd = lim;
    const cands: [number, number][] = [
      ...this.w.landmarks.map((l): [number, number] => [l.x, l.z]),
      ...this.symbols.map((s): [number, number] => [s.x, s.z]),
      ...this.marks.map((k): [number, number] => [k.x, k.z]),
    ];
    for (const [cx, cz] of cands) {
      const d = Math.hypot(cx - x, cz - z);
      if (d < bd) { bd = d; best = [cx, cz]; }
    }
    return best;
  }

  /** Id of the symbol (landmark index or mission post id) nearest to a sheet point, within 24 px. */
  private pickSymbol(x: number, z: number): number {
    const lim = 24 / this.zoom;
    let best = -1;
    let bd = lim;
    this.w.landmarks.forEach((l, i) => {
      const d = Math.hypot(l.x - x, l.z - z);
      if (d < bd) { bd = d; best = i; }
    });
    for (const s of this.symbols) {
      const d = Math.hypot(s.x - x, s.z - z);
      if (d < bd) { bd = d; best = s.id; }
    }
    return best;
  }

  private setLoupe(e: PointerEvent | null) {
    if (!e) { this.loupe = null; return; }
    const r = this.canvas.getBoundingClientRect();
    this.loupe = { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** Which ruler end lies under the finger (within 28 screen px), if any. */
  private rulerEndAt(x: number, z: number): 'a' | 'b' | null {
    const r = this.ruler;
    if (!r) return null;
    const da = Math.hypot(r.ax - x, r.az - z) * this.zoom, db = Math.hypot(r.bx - x, r.bz - z) * this.zoom;
    if (Math.min(da, db) > 28) return null;
    return db <= da ? 'b' : 'a';
  }

  private onDown = (e: PointerEvent) => {
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY });
    if (this.pointers.size >= 2) {
      // A second finger always means pinch / pan / twist; drop a stroke that has barely started.
      if (this.drawing && this.drawing.pts.length < 6) this.strokes.pop();
      this.drawing = null;
      this.gesture = 'pinch';
      this.loupe = null;
      return;
    }
    if (e.pointerType === 'mouse' && e.button === 2) { this.gesture = 'pan'; return; }
    const [x, z] = this.screenToSheet(e.clientX, e.clientY);
    if (this.request?.kind === 'symbol') {
      // Tap a symbol; a drag pans.
      this.gesture = 'tool';
      this.dirty = true;
      return;
    }
    if (this.request?.kind === 'mark' && this.tool === 'tanda') {
      // Press, slide while watching the loupe, release to place. The map does not move meanwhile
      // (pan with two fingers or the Geser tool).
      this.gesture = 'mark-move';
      this.request.at = [x, z];
      this.setLoupe(e);
      this.dirty = true;
      return;
    }
    this.gesture = this.tool === 'geser' ? 'pan' : 'tool';
    if (this.tool === 'penggaris') {
      // Touch: drag an end of the ruler, or pan (the ends are set with the buttons). Mouse: drag to measure.
      const end = this.rulerEndAt(x, z);
      if (end) {
        this.gesture = 'ruler-end';
        this.rulerEnd = end;
        if (end === 'b') this.rulerLive = false;
        this.setLoupe(e);
      } else if (e.pointerType === 'mouse') {
        const [sx, sz] = this.snap(x, z);
        this.ruler = { ax: sx, az: sz, bx: sx, bz: sz };
        this.rulerEnd = 'b';
        this.rulerLive = false;
        this.gesture = 'ruler-end';
      } else this.gesture = 'pan';
      this.updateReadout();
      this.syncChrome();
    } else if (this.tool === 'titik') {
      this.setLoupe(e);
    } else if (this.tool === 'pensil') {
      const wt = this.writeTool();
      if (!wt) return;
      this.drawing = { pts: [x, z], pen: wt === 'pena' };
      this.strokes.push(this.drawing);
    } else if (this.tool === 'hapus') {
      this.eraseAt(x, z);
    } else if (this.tool === 'busur') {
      const p = this.protractor;
      if (p && Math.hypot(p.x - x, p.z - z) * this.zoom < 26) this.gesture = 'busur-move';
      else if (!p) {
        const [sx, sz] = this.snap(x, z);
        this.protractor = { x: sx, z: sz, az: 0 };
        this.protInput.value = '0';
        this.gesture = 'busur-move';
      } else this.aimProtractor(x, z);
      if (this.gesture === 'busur-move') this.setLoupe(e);
      this.updateReadout();
    }
    this.dirty = true;
  };

  private aimProtractor(x: number, z: number) {
    const p = this.protractor!;
    if (Math.hypot(x - p.x, z - p.z) * this.zoom < 20) return;
    p.az = Math.round(azimuthTo(p.x, p.z, x, z) * 2) / 2;
    this.protInput.value = String(p.az);
  }

  private onMove = (e: PointerEvent) => {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    const ids = [...this.pointers.keys()].slice(0, 2);
    if (this.gesture === 'pinch' && ids.length >= 2) {
      if (!ids.includes(e.pointerId)) return;
      const pa = this.pointers.get(ids[0])!, pb = this.pointers.get(ids[1])!;
      const a0 = { x: pa.x, y: pa.y }, b0 = { x: pb.x, y: pb.y };
      p.x = e.clientX;
      p.y = e.clientY;
      const [wx, wz] = this.screenToSheet((a0.x + b0.x) / 2, (a0.y + b0.y) / 2);
      const d0 = Math.hypot(b0.x - a0.x, b0.y - a0.y);
      const d1 = Math.hypot(pb.x - pa.x, pb.y - pa.y);
      if (d0 > 10) this.setZoom(this.zoom * (d1 / d0));
      if (!this.lockRot) this.rot += Math.atan2(pb.y - pa.y, pb.x - pa.x) - Math.atan2(b0.y - a0.y, b0.x - a0.x);
      this.pin(wx, wz, (pa.x + pb.x) / 2, (pa.y + pb.y) / 2);
      this.updateOrient();
      return;
    }
    if (this.gesture === 'pan') {
      if (e.pointerType === 'mouse' && (e.buttons & 2)) this.rotateBy((e.clientX - p.x) * 0.01);
      else {
        const [ax, az] = this.screenToSheet(p.x, p.y);
        this.pin(ax, az, e.clientX, e.clientY);
      }
    } else if (this.gesture === 'mark-move' && this.request?.kind === 'mark') {
      this.request.at = this.screenToSheet(e.clientX, e.clientY);
      this.setLoupe(e);
      this.dirty = true;
    } else if (this.gesture === 'ruler-end' && this.ruler) {
      const [sx, sz] = this.snap(...this.screenToSheet(e.clientX, e.clientY));
      if (this.rulerEnd === 'a') { this.ruler.ax = sx; this.ruler.az = sz; } else { this.ruler.bx = sx; this.ruler.bz = sz; }
      if (this.loupe) this.setLoupe(e);
      this.updateReadout();
      this.dirty = true;
    } else if (this.gesture === 'tool' || this.gesture === 'busur-move') {
      const [x, z] = this.screenToSheet(e.clientX, e.clientY);
      if (this.request?.kind === 'symbol') {
        if (Math.hypot(e.clientX - p.sx, e.clientY - p.sy) > 10) this.gesture = 'pan';
      } else if (this.tool === 'titik') {
        this.setLoupe(e);
      } else if (this.tool === 'pensil' && this.drawing) {
        const pts = this.drawing.pts;
        if (Math.hypot(pts[pts.length - 2] - x, pts[pts.length - 1] - z) * this.zoom > 2) pts.push(x, z);
      } else if (this.tool === 'hapus') {
        this.eraseAt(x, z);
      } else if (this.tool === 'busur' && this.protractor) {
        if (this.gesture === 'busur-move') this.setLoupe(e);
        if (this.gesture === 'busur-move') {
          const [sx, sz] = this.snap(x, z);
          this.protractor.x = sx;
          this.protractor.z = sz;
        } else this.aimProtractor(x, z);
        this.updateReadout();
      }
      this.dirty = true;
    }
    p.x = e.clientX;
    p.y = e.clientY;
  };

  private onUp = (e: PointerEvent) => {
    const p = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (!p) return;
    const tap = Math.hypot(e.clientX - p.sx, e.clientY - p.sy) < 10;
    if (this.gesture === 'mark-move' && this.request?.kind === 'mark') this.bannerOk.disabled = false;
    if (this.gesture === 'tool' && this.pointers.size === 0) {
      const [x, z] = this.screenToSheet(e.clientX, e.clientY);
      if (this.request?.kind === 'symbol' && tap) {
        const id = this.pickSymbol(x, z);
        if (id >= 0) {
          const r = this.request;
          this.endRequest();
          r.done(id);
        }
      } else if (this.tool === 'titik') {
        // Press, slide while watching the loupe, release to place.
        const wt = this.writeTool();
        if (wt) this.marks.push({ x, z, label: String(this.marks.length + 1), pen: wt === 'pena' });
      } else if (this.tool === 'pensil' && this.drawing && this.drawing.pts.length < 4) {
        this.strokes.pop();
      }
    }
    if (this.pointers.size === 0) {
      this.gesture = 'none';
      this.drawing = null;
      this.loupe = null;
      this.syncChrome();
    }
    this.dirty = true;
  };

  private eraseAt(x: number, z: number) {
    if (!this.tools.has('penghapus')) return;
    const r = 12 / this.zoom;
    const near = (px: number, pz: number) => Math.hypot(px - x, pz - z) < r;
    // Pen cannot be erased, only pencil.
    this.strokes = this.strokes.filter((s) => s.pen || !polyNear(s.pts, x, z, r));
    this.marks = this.marks.filter((k) => k.pen || !near(k.x, k.z));
    this.lines = this.lines.filter((l) => {
      if (l.pen) return true;
      const a = (l.az * Math.PI) / 180;
      return !polyNear([l.x, l.z, l.x + Math.sin(a) * l.len, l.z - Math.cos(a) * l.len], x, z, r);
    });
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const [wx, wz] = this.screenToSheet(e.clientX, e.clientY);
    this.setZoom(this.zoom * Math.exp(-e.deltaY * 0.0015));
    this.pin(wx, wz, e.clientX, e.clientY);
  };
}

/** Paper length in cm of a distance in blocks at the map scale. */
export function blocksToCm(blocks: number): number {
  return ((blocks * BLOCK_M) / MAP_SCALE) * 100;
}

function fmtCm(blocks: number): string {
  return blocksToCm(blocks).toFixed(2).replace('.', ',');
}

function polyNear(pts: number[], x: number, z: number, r: number): boolean {
  for (let k = 0; k + 3 < pts.length; k += 2) {
    const ax = pts[k], az = pts[k + 1], bx = pts[k + 2], bz = pts[k + 3];
    const vx = bx - ax, vz = bz - az;
    const L = vx * vx + vz * vz;
    let t = L > 0 ? ((x - ax) * vx + (z - az) * vz) / L : 0;
    t = Math.max(0, Math.min(1, t));
    if (Math.hypot(ax + vx * t - x, az + vz * t - z) < r) return true;
  }
  return pts.length === 2 && Math.hypot(pts[0] - x, pts[1] - z) < r;
}

function addPoly(p: Path2D, pts: number[]) {
  if (pts.length < 4) return;
  p.moveTo(pts[0], pts[1]);
  for (let k = 2; k < pts.length; k += 2) p.lineTo(pts[k], pts[k + 1]);
}

function div(cls: string): HTMLDivElement {
  const d = document.createElement('div');
  if (cls) d.className = cls;
  return d;
}

function button(text: string, cls: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = cls;
  b.textContent = text;
  return b;
}

/** Map symbols in screen pixels, centred on the origin. */
export function drawSymbol(ctx: CanvasRenderingContext2D, kind: Landmark['kind']) {
  switch (kind) {
    case 'peak':
      ctx.beginPath();
      ctx.moveTo(0, -5); ctx.lineTo(5, 4); ctx.lineTo(-5, 4); ctx.closePath();
      ctx.fill();
      break;
    case 'tower':
      ctx.beginPath();
      ctx.moveTo(-4, 6); ctx.lineTo(0, -3); ctx.lineTo(4, 6);
      ctx.moveTo(0, -3); ctx.lineTo(0, -7);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, -8, 1.8, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'hut':
      ctx.fillRect(-4, -4, 8, 8);
      break;
    case 'lonetree':
      ctx.beginPath();
      ctx.moveTo(0, 6); ctx.lineTo(0, 1);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, -2, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = '#4c8a3e';
      ctx.fill();
      ctx.stroke();
      break;
    case 'monument':
      ctx.beginPath();
      ctx.moveTo(-1.8, 4); ctx.lineTo(-1.1, -5); ctx.lineTo(0, -7.5); ctx.lineTo(1.1, -5); ctx.lineTo(1.8, 4); ctx.closePath();
      ctx.fill();
      ctx.fillRect(-4, 4, 8, 2);
      break;
    case 'bridge':
      break;
  }
}
