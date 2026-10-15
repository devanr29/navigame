// Sighting compass: hold to raise it to eye level, aim the crosshair, release to record the reading.
// The needle is a damped spring, so it swings when raised or turned and the player learns to wait
// for it to settle before reading.
import type { Reading } from '../game/state';
import { angleDiff, norm360 } from './sight';

const SPRING = 30; // stiffness
const DAMPING = 3.2; // under-damped: a few visible swings, settles in about 2 s
const SPAN = 40; // degrees visible either side of the index line

export class Compass {
  raised = false;
  /** Locked bearing (kunci kompas), drawn as a green mark on the card; null when not locked. */
  locked: number | null = null;
  readonly readings: Reading[] = [];
  private needle = 0;
  private vel = 0;
  private jitter = 0;
  private lastTarget = 0;
  private ctx: CanvasRenderingContext2D;

  constructor(private overlay: HTMLElement, private tape: HTMLCanvasElement) {
    this.ctx = tape.getContext('2d')!;
  }

  /** Raises the compass. `azimuth` is the true magnetic azimuth the player faces. */
  raise(azimuth: number) {
    this.raised = true;
    // Lifting the compass disturbs the needle.
    this.needle = azimuth + (Math.random() < 0.5 ? -1 : 1) * (15 + Math.random() * 20);
    this.vel = 0;
    this.lastTarget = azimuth;
    this.overlay.hidden = false;
    this.resize();
  }

  /** Lowers the compass and returns the azimuth it showed (or null if it was not raised). */
  lower(): { azimuth: number; settled: boolean } | null {
    if (!this.raised) return null;
    this.raised = false;
    this.overlay.hidden = true;
    return { azimuth: this.shown(), settled: this.settled() };
  }

  update(dt: number, azimuth: number) {
    if (!this.raised) return;
    // Integrate in small steps so the spring stays stable at low frame rates.
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / steps;
    for (let s = 0; s < steps; s++) {
      const err = angleDiff(azimuth, this.needle);
      this.vel += (SPRING * err - DAMPING * this.vel) * h;
      this.needle += this.vel * h;
    }
    // A faint tremor that never fully stops, like a real needle.
    this.jitter += (Math.random() - 0.5) * dt * 6;
    this.jitter *= 1 - Math.min(1, dt * 3);
    this.lastTarget = azimuth;
    this.draw();
  }

  /** Whole-degree reading on the compass card. */
  shown(): number {
    return Math.round(norm360(this.needle + this.jitter)) % 360;
  }

  settled(): boolean {
    return Math.abs(this.vel) < 1.5 && Math.abs(angleDiff(this.lastTarget, this.needle)) < 1;
  }

  private resize() {
    const r = this.tape.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.tape.width = Math.round(r.width * dpr);
    this.tape.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private draw() {
    const ctx = this.ctx;
    const W = this.tape.clientWidth;
    const H = this.tape.clientHeight;
    const a = norm360(this.needle + this.jitter);
    const pxPerDeg = W / (2 * SPAN);
    const tapeH = 40;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(12, 18, 14, 0.72)';
    roundRect(ctx, 0, 0, W, tapeH, 8);
    ctx.fill();

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, tapeH);
    ctx.clip();
    ctx.strokeStyle = '#f4f1e8';
    ctx.fillStyle = '#f4f1e8';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    const first = Math.ceil((a - SPAN - 2) / 5) * 5;
    for (let d = first; d <= a + SPAN + 2; d += 5) {
      const x = W / 2 + (d - a) * pxPerDeg;
      const dn = norm360(d);
      const major = dn % 30 === 0;
      const mid = dn % 10 === 0;
      ctx.lineWidth = major ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(x, tapeH);
      ctx.lineTo(x, tapeH - (major ? 14 : mid ? 10 : 6));
      ctx.stroke();
      const label = CARDINAL[dn] ?? (major ? String(dn) : '');
      if (label) {
        ctx.font = CARDINAL[dn] ? '700 15px system-ui, sans-serif' : '600 12px system-ui, sans-serif';
        ctx.fillStyle = dn === 0 ? '#ff5a4e' : '#f4f1e8';
        ctx.fillText(label, x, tapeH - 18);
      }
    }
    if (this.locked !== null) {
      const off = angleDiff(this.locked, a);
      if (Math.abs(off) <= SPAN) {
        const x = W / 2 + off * pxPerDeg;
        ctx.fillStyle = '#3fdc6a';
        ctx.beginPath();
        ctx.moveTo(x - 8, tapeH);
        ctx.lineTo(x + 8, tapeH);
        ctx.lineTo(x, tapeH - 12);
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.restore();

    // index mark
    ctx.fillStyle = '#f5d21e';
    ctx.beginPath();
    ctx.moveTo(W / 2 - 7, 0);
    ctx.lineTo(W / 2 + 7, 0);
    ctx.lineTo(W / 2, 10);
    ctx.closePath();
    ctx.fill();
    ctx.fillRect(W / 2 - 1, 0, 2, tapeH);

    // digital readout
    const txt = `${String(this.shown()).padStart(3, '0')}°`;
    ctx.font = '700 22px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const tw = ctx.measureText(txt).width + 20;
    ctx.fillStyle = 'rgba(12, 18, 14, 0.72)';
    roundRect(ctx, W / 2 - tw / 2, tapeH + 6, tw, 30, 6);
    ctx.fill();
    ctx.fillStyle = this.settled() ? '#f5d21e' : '#f4f1e8';
    ctx.fillText(txt, W / 2, tapeH + 10);
    if (this.locked !== null) {
      ctx.font = '600 12px system-ui, sans-serif';
      ctx.fillStyle = '#3fdc6a';
      ctx.textAlign = 'left';
      ctx.fillText(`kunci ${String(Math.round(this.locked)).padStart(3, '0')}°`, W / 2 + tw / 2 + 8, tapeH + 16);
    }
  }
}

const CARDINAL: Record<number, string> = { 0: 'U', 45: 'TL', 90: 'T', 135: 'TG', 180: 'S', 225: 'BD', 270: 'B', 315: 'BL' };

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
