// Runs the game after the world is generated: menus → packing → quiz → briefing → destination → field
// mission → debrief. Owns the 3D view, the HUD and the tools.
import * as THREE from 'three';
import { DevTools } from '../dev/devtools';
import { Zone, type WorldData } from '../gen/constants';
import { makeRng } from '../gen/noise';
import { MapView } from '../map/mapView';
import { Input } from '../player/input';
import { Player } from '../player/player';
import { Compass, HeadingStrip } from '../tools/compass';
import { azimuthOfYaw, magneticOf, Sight } from '../tools/sight';
import { Notebook } from '../ui/notebook';
import { CharacterPreview } from '../ui/preview';
import { askNumbers, el, Screens } from '../ui/screens';
import { ChunkManager } from '../world/chunks';
import { makeCharacter, makeFirstPersonArm } from '../world/characters';
import { SKY_FOREST, SKY_OPEN } from '../world/colors';
import { buildLandmarks } from '../world/landmarks3d';
import { createMission, fmtCoord, LEVELS, type Action, type Ctx, type Mission } from './missions';
import { DEFAULT_PACE, PaceCounter } from './pace';
import { makeQuestion, type Question } from './quiz';
import type { P, Sites } from './sites';
import { ALL_TOOLS, DEV_KEY, loadProgress, saveProgress, TOOLS, type Reading, type ToolId } from './state';
import { Team } from './team';

// View distances in blocks (1 block = 2.5 m). Open terrain: 1.4 km, nearly the whole 1.5 km sheet,
// so landmarks across the map can be sighted. Where the haze starts depends on the mission's weather
// (Mission.haze): clear days in the early levels so the terrain can be read, a light haze later, as in
// the field. The far limit stays the same, so the same landmarks can be sighted in any weather.
// Forest: heavy fog under the canopy.
const CLEAR_NEAR = 380, HAZY_NEAR = 230, OPEN_FAR = 560;
const FOREST_NEAR = 3, FOREST_FAR = 30;
const LOAD_RADIUS = OPEN_FAR + 16;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export interface GameOptions {
  debug: boolean;
  /** Developer testing: jump straight into a level with every tool, skipping the menus. */
  debugLevel: number | null;
  /** Developer mode (/developer): every level open, flight, exact position, mission inspector. */
  dev: boolean;
  seed: string;
  logoUrl: string;
}

export class Game {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private chunks: ChunkManager;
  private landmarks: ReturnType<typeof buildLandmarks>;
  private player: Player;
  private input: Input;
  private map: MapView;
  private sight: Sight;
  private compass: Compass;
  private notebook: Notebook;
  private team: Team;
  private pace = new PaceCounter();
  private screens: Screens;
  private progress: ReturnType<typeof loadProgress>;
  private devtools: DevTools | null = null;
  /** Developer mode: skip packing, quiz, briefing and destination marking (all tools packed). */
  private devQuick = false;
  private arm = makeFirstPersonArm();
  /** The player's own body, seen in the third-person view. */
  private body = makeCharacter('compasman');
  private thirdPerson = false;
  private heading = new HeadingStrip($<HTMLCanvasElement>('heading'));

  private mode: 'menu' | 'field' = 'menu';
  private mission: Mission | null = null;
  private tools = new Set<ToolId>(ALL_TOOLS);
  private mapOpen = false;
  private pendingMark: ((p: P | null) => void) | null = null;
  private onFieldEnd: (() => void) | null = null;

  private sky = new THREE.Color(SKY_OPEN);
  private skyOpen = new THREE.Color(SKY_OPEN);
  private skyForest = new THREE.Color(SKY_FOREST);
  private forest = 0;
  private pixelRatio: number;
  private maxPR: number;
  private actionKey = '';
  private hudTimer = 0;
  private toastTimer = 0;

  constructor(private w: WorldData, private sites: Sites, private opts: GameOptions) {
    this.progress = loadProgress(opts.dev ? DEV_KEY : undefined);
    const canvas = $<HTMLCanvasElement>('view');
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.maxPR = Math.min(window.devicePixelRatio || 1, 1.5);
    this.pixelRatio = this.maxPR;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.scene.background = this.sky;
    this.scene.fog = new THREE.Fog(this.sky, CLEAR_NEAR, OPEN_FAR);
    this.camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, OPEN_FAR + 20);
    this.camera.add(this.arm);
    this.scene.add(this.camera);
    this.body.group.visible = false;
    this.scene.add(this.body.group);

    this.chunks = new ChunkManager(w);
    this.scene.add(this.chunks.root);
    this.landmarks = buildLandmarks(w.landmarks);
    this.scene.add(this.landmarks.group);
    this.player = new Player(w, w.spawn, [w.landmarks[0].x, w.landmarks[0].z]);
    this.player.slowAt = (x, z) => (this.chunks.bushGrid[Math.floor(z) * w.size + Math.floor(x)] ? 0.55 : 1);
    this.input = new Input($('touch'), canvas, $('joy'), $('knob'));
    this.input.forceForward = opts.debug && new URLSearchParams(location.search).has('autowalk');
    this.map = new MapView($<HTMLCanvasElement>('map'), w, $('map-screen'));
    this.sight = new Sight(w);
    this.compass = new Compass($('sight'), $<HTMLCanvasElement>('compass-tape'));
    this.notebook = new Notebook($('notebook'), $('notebook-body'));
    this.notebook.symbolName = (id) => w.landmarks[id]?.name ?? this.map.symbols.find((s) => s.id === id)?.label ?? '?';
    this.notebook.onPair = (i) => this.pairReading(i);
    this.map.onRequestCancel = () => {
      const r = this.pendingMark;
      this.pendingMark = null;
      r?.(null);
    };
    this.team = new Team(w, this.chunks);
    this.scene.add(this.team.group);
    this.screens = new Screens($('screen'), opts.logoUrl, new CharacterPreview());

    this.bindHud();
    // Developer testing only: automated test scripts read and drive the game through this handle.
    if (opts.debug || opts.dev) (window as unknown as { __game: Game }).__game = this;
    if (opts.dev) this.devtools = this.makeDevTools();
    window.addEventListener('resize', () => {
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
    });
    let last = performance.now();
    const frame = (now: number) => {
      requestAnimationFrame(frame);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      this.devtools?.tick(dt);
      if (this.mode === 'field' && !document.hidden) {
        if (!this.mapOpen) this.fieldFrame(dt, now);
        // While the map is open the world is paused, but the mission keeps checking objectives
        // (orienting the map happens on the map) and time keeps running.
        else if (this.mission && !this.mission.result) {
          this.mission.update(dt);
          this.endIfDone();
        }
      }
    };
    requestAnimationFrame(frame);
  }

  /** Builds the chunks around a point before showing it. */
  async preload(x: number, z: number, onProgress?: (f: number) => void) {
    await new Promise<void>((resolve) => {
      const step = () => {
        const left = this.chunks.update(x, z, LOAD_RADIUS, 6);
        const total = this.chunks.built + left;
        onProgress?.(this.chunks.built / Math.max(1, total));
        if (left > 0) requestAnimationFrame(step);
        else resolve();
      };
      step();
    });
    this.renderer.compile(this.scene, this.camera);
  }

  // ================================================================== menus

  async run() {
    if (this.opts.debugLevel) {
      await this.playLevel(this.opts.debugLevel);
    }
    await this.screens.title();
    for (;;) {
      const n = this.opts.dev
        ? await this.screens.levels(LEVELS, { ...this.progress, unlocked: 10 }, this.devLevelOptions())
        : await this.screens.levels(LEVELS, this.progress);
      await this.playLevel(n);
    }
  }

  private async playLevel(n: number) {
    let level = n;
    for (;;) {
      const outcome = await this.playOnce(level);
      if (outcome === 'menu') return;
      if (outcome === 'next') level = Math.min(10, level + 1);
    }
  }

  private async playOnce(n: number): Promise<'retry' | 'next' | 'menu'> {
    const info = LEVELS[n - 1];
    const quickDebug = this.opts.debugLevel === n || this.devQuick;
    const rnd = makeRng((Date.now() & 0xffffff) ^ (n * 7919));
    const packed = quickDebug ? { tools: new Set(ALL_TOOLS), extras: [] } : await this.screens.packing(info, n >= 3, rnd);
    this.tools = packed.tools;
    const missing = TOOLS.filter((t) => !this.tools.has(t.id)).map((t) => t.name);
    const extraLessons = packed.extras.length
      ? [`Barang yang bukan alat navigasi ikut dikemas: ${packed.extras.map((d) => d.name).join(', ')}.`, ...packed.extras.map((d) => d.why)]
      : [];
    this.map.resetSheet();
    this.map.setTools(this.tools);
    this.notebook.reset();
    this.notebook.canWrite = this.tools.has('pena') || this.tools.has('pensil');

    // ---- level 1: base camp quiz only
    if (n === 1) {
      const kinds: Question['kind'][] = ['coord', 'scale', 'contour', 'karvak'];
      const qs = kinds.map((k) => makeQuestion(k, this.w, this.map, rnd));
      const res = await this.screens.quiz('Level 1 · Cek pengetahuan peta', qs, () => this.peekMap());
      const score = Math.round((100 * res.firstTry) / res.total);
      const result = {
        passed: true,
        score: Math.round(score * (missing.length ? 0.8 : 1) * (packed.extras.length ? 0.9 : 1)),
        stats: [
          ['Benar pada percobaan pertama', `${res.firstTry} dari ${res.total}`],
          ['Barang salah kemas', String(packed.extras.length)],
        ] as [string, string][],
        lessons: [
          ...extraLessons,
          'Koordinat ditulis lintang dulu, lalu bujur. 1 menit = 60 detik.',
          'Jarak di peta × skala = jarak sebenarnya: 1 cm pada 1:25.000 = 250 m.',
          'Lembahan: kontur melengkung ke arah puncak. Punggungan: kontur melengkung menjauhi puncak.',
        ],
      };
      this.recordResult(n, result.passed, result.score);
      this.devtools?.quizEnded(result);
      return this.screens.debrief(info, result, missing, n < 10, () => this.peekMap());
    }

    // ---- field mission
    const ctx = this.makeCtx();
    const mission = createMission(n, ctx)!;
    this.mission = mission;
    mission.start();
    this.devtools?.missionStarted(mission, n);
    this.map.redraw();

    if (!quickDebug) {
      const kinds: Question['kind'][] = ['coord', 'scale', 'contour', 'karvak'];
      const q = makeQuestion(kinds[Math.floor(rnd() * kinds.length)], this.w, this.map, rnd);
      await this.screens.quiz(`Level ${n} · Cek cepat`, [q], () => this.peekMap());
      const extra: string[] = [];
      if (missing.length) extra.push(`Alat tertinggal: ${missing.join(', ')}.`);
      if (mission.haze > 0) extra.push('Cuaca hari ini berkabut tipis: bukit dan titik ekstrem yang jauh tampak samar, seperti sering terjadi di lapangan. Bidik dengan teliti.');
      await this.screens.briefing(info, mission.briefing, extra);
    }
    this.screens.hide();

    $('loading-mini').hidden = false;
    await this.preload(this.player.x, this.player.z);
    $('loading-mini').hidden = true;

    if (mission.destination && !quickDebug) await this.markDestination(mission);

    await this.runField(mission);
    const r = mission.result!;
    r.lessons.unshift(...extraLessons);
    this.recordResult(n, r.passed, r.score);
    this.devtools?.missionEnded(n, r);
    const out = await this.screens.debrief(info, r, missing, n < 10, () => this.peekMap());
    mission.cleanup();
    this.mission = null;
    return out;
  }

  private recordResult(n: number, passed: boolean, score: number) {
    if (passed) this.progress.unlocked = Math.max(this.progress.unlocked, Math.min(10, n + 1));
    this.progress.best[n] = Math.max(this.progress.best[n] ?? 0, score);
    saveProgress(this.progress, this.opts.dev ? DEV_KEY : undefined);
  }

  /** Shows the map over a menu screen (read-only use: quiz, debrief). */
  private peekMap(): Promise<void> {
    return new Promise<void>((resolve) => {
      // Only hide the menu screen: its content (the quiz question, the debrief) must still be there
      // when the map is closed.
      const prevRoot = $('screen');
      prevRoot.hidden = true;
      this.openMap(true);
      const close = $('map-close');
      const handler = () => {
        close.removeEventListener('click', handler, true);
        prevRoot.hidden = false;
        resolve();
      };
      close.addEventListener('click', handler, true);
    }).then(() => { $('screen').hidden = false; });
  }

  // ================================================================== field

  private makeCtx(): Ctx {
    return {
      w: this.w,
      sites: this.sites,
      sight: this.sight,
      player: this.player,
      map: this.map,
      notebook: this.notebook,
      team: this.team,
      pace: this.pace,
      scene: this.scene,
      tools: this.tools,
      progress: this.progress,
      saveProgress: () => saveProgress(this.progress, this.opts.dev ? DEV_KEY : undefined),
      toast: (t, l) => this.toast(t, l ?? []),
      askMark: (prompt) => this.askMark(prompt),
      askNumbers: (title, fields) => {
        if (!this.tools.has('kompas')) {
          this.toast('Kompas tertinggal', ['Kompas tidak bisa dikunci tanpa kompas.']);
          return Promise.resolve(null);
        }
        this.input.reset();
        return askNumbers($('dialog'), title, fields);
      },
      lockCompass: (az) => {
        this.compass.locked = az;
        this.team.locked = az;
      },
    };
  }

  private askMark(prompt: string): Promise<P | null> {
    if (!this.tools.has('peta')) {
      this.toast('Peta tertinggal', ['Tanpa peta posisi tidak bisa ditandai.']);
      return Promise.resolve(null);
    }
    if (!this.tools.has('pensil') && !this.tools.has('pena')) {
      this.toast('Tidak ada alat tulis', ['Tanpa pensil atau pena, peta tidak bisa ditandai.']);
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      this.pendingMark = resolve;
      if (!this.mapOpen) this.openMap(true);
      this.map.requestMark(prompt, (x, z) => {
        this.pendingMark = null;
        resolve([x, z]);
        if (this.mode === 'field') this.openMap(false);
      });
    });
  }

  /** Phase A step 3: mark the destination from its coordinates before leaving. */
  private async markDestination(m: Mission) {
    const d = m.destination!;
    if (!this.tools.has('peta') || (!this.tools.has('pensil') && !this.tools.has('pena'))) {
      this.toast('Tujuan tidak bisa ditandai', ['Peta atau alat tulis tertinggal.']);
      return;
    }
    this.mode = 'menu';
    for (let tries = 1; tries <= 3; tries++) {
      const p = await new Promise<P | null>((resolve) => {
        this.openMap(true);
        this.map.requestMark(`Tandai ${d.label}: ${fmtCoord(d.p)}. Ukur dari garis karvak (penggaris), lalu Tanda → Kirim`, (x, z) => resolve([x, z]));
        this.pendingMark = resolve;
      });
      this.pendingMark = null;
      if (!p) { tries--; continue; }
      const err = Math.hypot(p[0] - d.p[0], p[1] - d.p[1]) * 2.5;
      m.destinationTries = tries;
      // 100 m (4 mm on the sheet): a fingertip on a phone is not a sharp pencil.
      if (err <= 100) {
        this.map.marks.push({ x: p[0], z: p[1], label: d.label, pen: !this.tools.has('pensil') });
        this.toast('Tujuan ditandai', [`Meleset ${Math.round(err)} m dari koordinat. Bagus.`]);
        break;
      }
      if (tries === 3) {
        this.map.marks.push({ x: d.p[0], z: d.p[1], label: d.label, pen: false });
        this.toast('Tujuan ditandai oleh pelatih', [`Tanda terakhirmu meleset ${Math.round(err)} m. Pelajari lagi cara membaca koordinat.`]);
      } else {
        this.toast('Belum tepat', [`Tandamu meleset ${Math.round(err)} m dari koordinat. Baca lagi garis karvak dan label tepi peta.`]);
      }
    }
    this.openMap(false);
  }

  private runField(m: Mission): Promise<void> {
    return new Promise((resolve) => {
      this.mode = 'field';
      this.pace.reset();
      this.paceX = this.player.x;
      this.paceZ = this.player.z;
      this.compass.locked = null;
      this.team.locked = null;
      this.forest = this.forestAmount();
      $('hud').hidden = false;
      $('btn-compass').classList.toggle('disabled', !this.tools.has('kompas'));
      $('btn-map').classList.toggle('disabled', !this.tools.has('peta'));
      $('pace').hidden = !m.showPace;
      this.actionKey = '';
      this.renderHud();
      this.onFieldEnd = () => {
        this.mode = 'menu';
        $('hud').hidden = true;
        this.compass.lower();
        this.notebook.close();
        this.input.reset();
        document.exitPointerLock?.();
        resolve();
      };
    });
  }

  private fieldFrame(dt: number, now: number) {
    const m = this.mission;
    const { player, camera, input } = this;
    input.poll();

    const fov = this.compass.raised ? 30 : 70;
    if (Math.abs(camera.fov - fov) > 0.05) {
      camera.fov += (fov - camera.fov) * Math.min(1, dt * 12);
      camera.updateProjectionMatrix();
    }
    player.frozen = this.compass.raised || this.notebook.isOpen();
    player.lookScale = camera.fov / 70;

    // team (navtup): joystick forward or W moves the team along the penerabas heading
    const forward = this.team.cutting ? Math.max(0, input.moveY) : 0;
    this.team.update(dt, forward, player, now / 1000);
    player.update(dt, input);
    player.applyCamera(camera);
    // Third person: the camera sits behind and a little right of the head. Sighting is always
    // through the compass, so raising it returns to the eye.
    const third = this.thirdPerson && !this.compass.raised;
    this.body.group.visible = third;
    this.arm.visible = !third && !this.compass.raised;
    if (third) this.placeThirdPerson(dt);
    const facing = magneticOf(azimuthOfYaw(player.yaw));
    this.compass.update(dt, facing);
    const headingEl = $('heading');
    headingEl.hidden = this.compass.raised || !this.tools.has('kompas');
    if (!headingEl.hidden) this.heading.update(facing, this.compass.locked);

    // pace counter: climb measured on the smooth terrain surface, not the 2.5 m block steps
    const N = this.w.size;
    const hf = (x: number, z: number) => {
      // bilinear between cell centres, so the slope is smooth instead of jumping at cell edges
      const fx = Math.min(N - 1.001, Math.max(0, x - 0.5)), fz = Math.min(N - 1.001, Math.max(0, z - 0.5));
      const x0 = Math.floor(fx), z0 = Math.floor(fz), tx = fx - x0, tz = fz - z0;
      const H = this.w.heightF;
      const a = H[z0 * N + x0], b = H[z0 * N + x0 + 1], c = H[(z0 + 1) * N + x0], d = H[(z0 + 1) * N + x0 + 1];
      return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
    };
    if (m?.showPace && !player.flying) {
      const brush = this.w.zone[Math.floor(player.z) * N + Math.floor(player.x)] === Zone.Forest;
      this.pace.add(player.moved, hf(player.x, player.z) - hf(this.paceX, this.paceZ), brush, player.sprinting);
    }
    this.paceX = player.x;
    this.paceZ = player.z;
    player.consumeMove();

    // zone fog
    const target = this.forestAmount();
    this.forest += (target - this.forest) * Math.min(1, dt * 1.5);
    const fog = this.scene.fog as THREE.Fog;
    const openNear = CLEAR_NEAR + (HAZY_NEAR - CLEAR_NEAR) * (m?.haze ?? 0);
    fog.near = openNear + (FOREST_NEAR - openNear) * this.forest;
    fog.far = OPEN_FAR + (FOREST_FAR - OPEN_FAR) * this.forest;
    this.sky.copy(this.skyOpen).lerp(this.skyForest, this.forest);
    fog.color.copy(this.sky);
    if (Math.abs(camera.far - (fog.far + 15)) > 1) {
      camera.far = fog.far + 15;
      camera.updateProjectionMatrix();
    }

    this.chunks.update(player.x, player.z, LOAD_RADIUS, 2);
    this.landmarks.update(now / 1000);
    m?.update(dt);
    this.renderer.render(this.scene, camera);

    this.hudTimer += dt;
    if (this.hudTimer > 0.2) {
      this.hudTimer = 0;
      this.renderHud();
    }
    this.adaptResolution(dt);

    this.endIfDone();
  }

  private placeThirdPerson(dt: number) {
    const { player, camera, body } = this;
    body.group.position.set(player.x, player.viewFootY, player.z);
    body.group.rotation.y = player.yaw;
    body.animate(dt, player.moved / Math.max(dt, 1e-3));
    // Behind and a little above and right of the head. The view keeps the player's yaw and pitch, so
    // aiming feels the same in both views; looking down swings the camera up over the head (looking up
    // does not swing it into the ground).
    const eye = camera.position;
    const p = Math.max(-1.2, Math.min(0.1, player.pitch));
    const back: [number, number, number] = [Math.sin(player.yaw) * Math.cos(p), -Math.sin(p), Math.cos(player.yaw) * Math.cos(p)];
    const right: [number, number] = [Math.cos(player.yaw), -Math.sin(player.yaw)];
    const D = 1.9, UP = 0.3, SIDE = 0.3; // blocks (about 5 m back)
    const at = (t: number): [number, number, number] => [
      eye.x + (back[0] * D + right[0] * SIDE) * t,
      eye.y + (back[1] * D + UP) * t,
      eye.z + (back[2] * D + right[1] * SIDE) * t,
    ];
    // Pull the camera in where a slope or a tree would come between it and the player.
    let t = 0;
    for (let k = 1; k <= 12; k++) {
      const [x, y, z] = at(k / 12);
      const xi = Math.floor(x), zi = Math.floor(z);
      if (xi < 0 || zi < 0 || xi >= this.w.size || zi >= this.w.size) break;
      const i = zi * this.w.size + xi;
      if (y < this.w.height[i] + 0.3 || this.w.solid[i]) break;
      t = k / 12;
    }
    eye.set(...at(t));
  }

  private toggleView() {
    this.thirdPerson = !this.thirdPerson;
    $('btn-view').classList.toggle('on', this.thirdPerson);
    this.toast(this.thirdPerson ? 'Sudut pandang orang ketiga' : 'Sudut pandang orang pertama',
      [this.thirdPerson ? 'Kompas tetap dibidik dari mata.' : '']);
  }

  private endIfDone() {
    if (this.mission?.result && this.onFieldEnd) {
      const end = this.onFieldEnd;
      this.onFieldEnd = null;
      setTimeout(() => {
        if (this.mapOpen) this.openMap(false);
        end();
      }, 900);
    }
  }

  private frames = 0;
  private fpsTime = 0;
  private paceX = 0;
  private paceZ = 0;
  private adaptResolution(dt: number) {
    this.frames++;
    this.fpsTime += dt;
    if (this.fpsTime < 2) return;
    const fps = this.frames / this.fpsTime;
    if (fps < 28 && this.pixelRatio > 0.6) this.pixelRatio = Math.max(0.6, this.pixelRatio * 0.85);
    else if (fps > 55 && this.pixelRatio < this.maxPR) this.pixelRatio = Math.min(this.maxPR, this.pixelRatio * 1.1);
    this.renderer.setPixelRatio(this.pixelRatio);
    const info = this.renderer.info.render;
    $('fps').textContent = `${Math.round(fps)} fps · res ${this.pixelRatio.toFixed(2)}x` +
      (this.opts.debug || this.opts.dev ? ` · ${info.calls} draws · ${Math.round(info.triangles / 1000)}k tris` : '');
    this.frames = 0;
    this.fpsTime = 0;
  }

  private forestAmount(): number {
    const w = this.w;
    let f = 0, n = 0;
    for (let dz = -8; dz <= 8; dz += 2) {
      for (let dx = -8; dx <= 8; dx += 2) {
        const xi = Math.floor(this.player.x + dx), zi = Math.floor(this.player.z + dz);
        if (xi < 0 || zi < 0 || xi >= w.size || zi >= w.size) continue;
        n++;
        if (w.zone[zi * w.size + xi] === Zone.Forest) f++;
      }
    }
    return n ? f / n : 0;
  }

  // ================================================================== HUD

  private bindHud() {
    const press = (id: string, fn: () => void) => $(id).addEventListener('pointerdown', (e) => { e.preventDefault(); fn(); });
    press('btn-map', () => {
      if (!this.tools.has('peta')) { this.toast('Peta tertinggal', ['Peta tidak dikemas di tas.']); return; }
      this.openMap(true);
    });
    $('map-close').addEventListener('click', () => this.openMap(false));
    $('map-north').addEventListener('click', () => this.map.northUp());
    $('map-legend').addEventListener('click', () => this.map.toggleLegend());
    press('btn-view', () => this.toggleView());
    press('btn-notebook', () => {
      if (this.notebook.isOpen()) this.notebook.close();
      else { this.input.reset(); this.notebook.open(); }
    });
    $('notebook-close').addEventListener('click', () => this.notebook.close());
    press('btn-menu', () => {
      if (this.mission && !this.mission.result && confirm('Keluar dari misi? Kemajuan misi ini hilang.')) {
        this.mission.result = { passed: false, score: 0, stats: [], lessons: ['Misi dihentikan.'] };
      }
    });
    $('btn-full').addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else void enterFullscreen();
    });
    const jumpBtn = $('btn-jump');
    jumpBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); this.input.jump(); });
    if (!matchMedia('(pointer: coarse)').matches) jumpBtn.hidden = true;
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || this.mode !== 'field') return;
      if (e.code === 'KeyM' && this.tools.has('peta')) this.openMap(!this.mapOpen);
      if (e.code === 'KeyN') $('btn-notebook').dispatchEvent(new PointerEvent('pointerdown'));
      if (e.code === 'KeyV') this.toggleView();
    });

    // compass: hold to raise, release to record
    const btn = $('btn-compass');
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      btn.setPointerCapture(e.pointerId);
      this.raiseCompass();
    });
    btn.addEventListener('pointerup', () => this.releaseCompass());
    btn.addEventListener('pointercancel', () => this.releaseCompass());
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => { if (e.code === 'KeyC' && !e.repeat && this.mode === 'field') this.raiseCompass(); });
    window.addEventListener('keyup', (e) => { if (e.code === 'KeyC') this.releaseCompass(); });
    window.addEventListener('mousedown', (e) => { if (e.button === 2 && this.mode === 'field' && !this.mapOpen) this.raiseCompass(); });
    window.addEventListener('mouseup', (e) => { if (e.button === 2) this.releaseCompass(); });
    $('view').addEventListener('contextmenu', (e) => e.preventDefault());
    $('touch').addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private openMap(open: boolean) {
    this.mapOpen = open;
    $('map-screen').hidden = !open;
    if (this.mode === 'field') $('hud').hidden = open;
    this.input.enabled = !open;
    this.input.reset();
    this.compass.lower();
    if (open) {
      $('toast').hidden = true;
      document.exitPointerLock?.();
      const inField = this.mode === 'field';
      this.map.orientFacing = this.mission?.orientCheck && inField ? azimuthOfYaw(this.player.yaw) : null;
      this.map.heading = inField && this.tools.has('kompas') ? magneticOf(azimuthOfYaw(this.player.yaw)) : null;
      this.map.devMarker = this.opts.dev && inField ? { x: this.player.x, z: this.player.z, az: azimuthOfYaw(this.player.yaw) } : null;
      // Readings that are ready to plot: paired with a symbol and with a back azimuth written down.
      const pad = (a: number) => `${String(Math.round(a)).padStart(3, '0')}°`;
      this.map.setNotes(inField ? this.notebook.readings
        .map((r, i) => ({ r, i }))
        .filter(({ r }) => r.pairedWith >= 0 && r.backTyped !== null)
        .map(({ r, i }) => `#${i + 1} ${this.notebook.symbolName(r.pairedWith)}: az ${pad(r.azimuth)} · back az ${pad(r.backTyped!)}`) : []);
      this.map.show();
      this.mission?.onMapOpen();
    } else {
      this.map.hide();
      if (this.pendingMark && this.map.hasRequest()) {
        const r = this.pendingMark;
        this.pendingMark = null;
        this.map.cancelRequest();
        r(null);
      }
      this.mission?.onMapClose();
    }
  }

  private raiseCompass() {
    if (this.mapOpen || this.compass.raised || this.mode !== 'field') return;
    if (!this.tools.has('kompas')) { this.toast('Kompas tertinggal', ['Kompas tidak dikemas di tas.']); return; }
    this.compass.raise(magneticOf(azimuthOfYaw(this.player.yaw)));
  }

  private releaseCompass() {
    const r = this.compass.lower();
    if (!r) return;
    const fog = this.scene.fog as THREE.Fog;
    const p = this.camera.position;
    const res = this.sight.sight(p.x, p.y, p.z, azimuthOfYaw(this.player.yaw), this.player.pitch, fog.far);
    const target = res.kind === 'hit' ? res.id : -1;
    const reading: Reading = { azimuth: r.azimuth, target, settled: r.settled, x: this.player.x, z: this.player.z, pairedWith: -1, backTyped: null };
    this.notebook.readings.push(reading);
    this.mission?.onReading(reading);
    const az = `${String(r.azimuth).padStart(3, '0')}°`;
    const wait = r.settled ? '' : 'Jarum belum tenang. Tunggu sampai diam sebelum melepas.';
    if (res.kind === 'hit') this.toast(`Azimut ${az} tercatat`, [target === 100 ? 'Asap terbidik.' : 'Titik ekstrem terbidik. Pasangkan dengan simbolnya di Catatan.', wait]);
    else if (res.kind === 'miss') this.toast(`Azimut ${az} tercatat`, ['Garis bidik tidak mengenai titik ekstrem.', wait]);
    else this.toast('Tidak ada titik ekstrem terlihat', [`Kompas menunjuk ${az}, tapi tidak ada yang bisa dibidik dari sini.`]);
  }

  /** Pair a reading with a map symbol: the player taps the symbol on the map. */
  private pairReading(i: number) {
    if (!this.tools.has('peta')) { this.toast('Peta tertinggal', []); return; }
    this.notebook.close();
    this.openMap(true);
    this.map.requestSymbol(`Ketuk simbol yang kamu bidik pada bidikan #${i + 1} (${String(this.notebook.readings[i].azimuth).padStart(3, '0')}°)`, (id) => {
      this.notebook.readings[i].pairedWith = id;
      this.openMap(false);
      this.notebook.open();
    });
  }

  // ================================================================== developer mode

  private makeDevTools() {
    const dev = new DevTools({
      seed: this.opts.seed,
      w: this.w,
      sites: this.sites,
      sight: this.sight,
      player: this.player,
      map: this.map,
      notebook: this.notebook,
      pace: this.pace,
      team: this.team,
      mission: () => this.mission,
      inField: () => this.mode === 'field',
      mapOpen: () => this.mapOpen,
      eye: () => [this.camera.position.x, this.camera.position.y, this.camera.position.z],
      viewRange: () => (this.scene.fog as THREE.Fog).far,
      tools: () => TOOLS.filter((t) => this.tools.has(t.id)).map((t) => t.name),
      teleport: (x, z) => this.devTeleport(x, z),
      teleportViaMap: () => {
        if (this.mapOpen || this.pendingMark) return;
        // A no-op resolver, so closing the map cancels the request like any other mark.
        this.pendingMark = () => {};
        this.openMap(true);
        this.map.requestMark('DEV: ketuk titik tujuan teleport, lalu Kirim', (x, z) => {
          this.pendingMark = null;
          this.openMap(false);
          this.devTeleport(x, z);
        });
      },
      grantAllTools: () => {
        this.tools = new Set(ALL_TOOLS);
        this.map.setTools(this.tools);
        this.notebook.canWrite = true;
        $('btn-compass').classList.remove('disabled');
        $('btn-map').classList.remove('disabled');
      },
      setFlying: (on) => { this.player.flying = on; },
    });
    dev.onUp = (v) => { this.input.touchUp = v; };
    return dev;
  }

  private devTeleport(x: number, z: number) {
    this.player.teleport(x, z, azimuthOfYaw(this.player.yaw));
    // The jump is not walking: keep it out of the pace counter.
    this.paceX = this.player.x;
    this.paceZ = this.player.z;
    this.chunks.update(x, z, LOAD_RADIUS, 24);
  }

  /** Developer mode options on the level select screen. */
  private devLevelOptions() {
    const box = el('input');
    box.type = 'checkbox';
    box.checked = this.devQuick;
    box.addEventListener('change', () => { this.devQuick = box.checked; });
    const reset = el('button', 'btn ghost small', 'Hapus progres dev');
    reset.addEventListener('click', () => {
      this.progress = { unlocked: 1, best: {}, paceCount: null };
      saveProgress(this.progress, DEV_KEY);
      reset.textContent = 'Progres dev dihapus';
    });
    return el('div', 'dev-levels',
      el('b', '', 'Mode developer'),
      el('span', 'muted small', ' · semua level terbuka · progres disimpan terpisah dari siswa'),
      el('label', 'dev-check', box, ' Alur cepat: semua alat dikemas, lewati kuis, briefing dan menandai tujuan'),
      reset,
    );
  }

  private toast(title: string, lines: string[]) {
    const t = $('toast');
    t.replaceChildren(el('b', '', title), ...lines.filter(Boolean).map((l) => el('div', '', l)));
    t.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => { t.hidden = true; }, 4500);
  }

  private renderHud() {
    const m = this.mission;
    if (!m) return;
    // objectives
    const obj = $('objectives');
    obj.replaceChildren(el('b', '', `Level ${m.level}`),
      ...m.objectives.map((o) => el('div', `obj${o.done ? ' done' : ''}${o.optional ? ' opt' : ''}`, `${o.done ? '✓' : '○'} ${o.text}${o.optional ? ' (opsional)' : ''}`)));
    // pace
    if (m.showPace) {
      const calib = this.progress.paceCount ?? DEFAULT_PACE;
      const beads = Math.floor(this.pace.steps / calib);
      $('pace').replaceChildren(
        el('div', '', `Langkah ${Math.round(this.pace.steps)}`),
        el('div', 'small', `Hitung ${Math.round(this.pace.tally)} · manik ${'●'.repeat(Math.min(9, beads))}${beads > 9 ? '+' : ''}`),
      );
    }
    // team gauge
    const g = $('gauge');
    const dev = this.team.cutting ? this.team.deviation() : null;
    g.hidden = dev === null;
    if (dev !== null) {
      const side = Math.abs(dev) < 1 ? 'lurus di azimut' : `${Math.abs(Math.round(dev))}° ke ${dev > 0 ? 'kanan' : 'kiri'}`;
      const needle = el('div', 'gauge-needle');
      needle.style.left = `${50 + Math.max(-45, Math.min(45, dev * 3))}%`;
      g.replaceChildren(
        el('div', '', `Kompas terkunci ${String(Math.round(this.team.locked ?? 0)).padStart(3, '0')}° · penerabas ${side}`),
        el('div', 'gauge-bar', el('div', 'gauge-mid'), needle),
        ...(this.team.blocked ? [el('div', 'warn', 'Terhalang! Lakukan detour.')] : []),
      );
    }
    // actions (rebuild only when the set changes)
    const acts = m.actions();
    const key = acts.map((a) => a.id + a.label).join('|');
    if (key !== this.actionKey) {
      this.actionKey = key;
      $('actions').replaceChildren(...acts.map((a) => this.actionButton(a)));
    }
  }

  private actionButton(a: Action) {
    const b = el('button', `btn ${a.primary ? '' : 'ghost'} small`, a.label);
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (a.hold) {
        b.setPointerCapture(e.pointerId);
        a.hold(true);
      } else a.run();
      this.actionKey = '';
    });
    if (a.hold) {
      const up = () => a.hold!(false);
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
    }
    return b;
  }
}

export async function enterFullscreen() {
  if (!matchMedia('(pointer: coarse)').matches) return;
  try {
    await document.documentElement.requestFullscreen?.({ navigationUI: 'hide' });
    await (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape');
  } catch {
    // Not supported (e.g. iOS Safari): the rotate-your-phone overlay still guides the player.
  }
}
