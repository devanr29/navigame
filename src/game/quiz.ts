// Map knowledge check (Phase A step 2), generated from the actual map so answers can be found on it.
import type { WorldData } from '../gen/constants';
import type { MapView } from '../map/mapView';
import { fmtCoord } from './missions';

export interface Question {
  kind: 'coord' | 'scale' | 'contour' | 'karvak';
  text: string;
  options: string[];
  answer: number;
  /** The answer is read from the map: offer a button to open it. */
  usesMap: boolean;
  /** Draws an illustration (contour shape) on a canvas. */
  diagram?: (c: HTMLCanvasElement) => void;
}

function shuffle<T>(a: T[], rnd: () => number): T[] {
  const b = a.slice();
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}

function withAnswer(correct: string, wrong: string[], rnd: () => number) {
  const opts = shuffle([correct, ...wrong.filter((x) => x !== correct).slice(0, 3)], rnd);
  return { options: opts, answer: opts.indexOf(correct) };
}

export function makeQuestion(kind: Question['kind'], w: WorldData, map: MapView, rnd: () => number): Question {
  const lms = w.landmarks.filter((l) => l.kind !== 'bridge');
  const l = lms[Math.floor(rnd() * lms.length)];
  switch (kind) {
    case 'coord': {
      const correct = fmtCoord([l.x, l.z]);
      const shift = (dx: number, dz: number) => fmtCoord([l.x + dx, l.z + dz]);
      const s = 10 * 30.86 / 2.5; // 10″ of latitude in blocks
      const wrong = [shift(s, 0), shift(0, s), shift(-s, -s), shift(s, -s)];
      return { kind, text: `Baca koordinat ${l.name} di peta (lintang dulu, lalu bujur).`, usesMap: true, ...withAnswer(correct, shuffle(wrong, rnd), rnd) };
    }
    case 'scale': {
      const cm = Math.round((1.5 + rnd() * 4.5) * 10) / 10;
      const m = Math.round(cm * 250);
      const f = (v: number) => (v >= 1000 ? `${String(v / 1000).replace('.', ',')} km` : `${v} m`);
      const wrong = [f(Math.round(m / 10)), f(m * 10), f(Math.round(cm * 100)), f(Math.round(cm * 2500 * 4))];
      return {
        kind,
        text: `Penggaris di peta skala 1:25.000 menunjukkan ${String(cm).replace('.', ',')} cm. Berapa jarak sebenarnya?`,
        usesMap: false,
        ...withAnswer(f(m), shuffle(wrong, rnd), rnd),
      };
    }
    case 'contour': {
      const valley = rnd() < 0.5;
      return {
        kind,
        text: 'Puncak ada di bagian atas gambar (angka kontur makin besar ke atas). Titik merah berada di…',
        options: ['Lembahan', 'Punggungan'],
        answer: valley ? 0 : 1,
        usesMap: false,
        diagram: (c) => drawContourShape(c, valley),
      };
    }
    case 'karvak': {
      const correct = map.karvakAt(l.x, l.z);
      const all = map.karvakNames().filter((k) => k !== correct);
      return { kind, text: `${l.name} terletak di karvak mana?`, usesMap: true, ...withAnswer(correct, shuffle(all, rnd), rnd) };
    }
  }
}

/**
 * Nested V-shaped contours: a valley's V points toward the peak (up), a ridge's V points away (down).
 * Beside a valley there are ridges and beside a ridge there are valleys, so the answer depends on where
 * you look: a red dot marks the spot being asked about, on the line through the bends of the Vs.
 */
function drawContourShape(c: HTMLCanvasElement, valley: boolean) {
  const g = c.getContext('2d')!;
  const W = c.width, H = c.height;
  g.fillStyle = '#fbf8ef';
  g.fillRect(0, 0, W, H);
  g.strokeStyle = '#9a5f2c';
  g.fillStyle = '#9a5f2c';
  g.lineWidth = 2;
  g.font = '600 12px system-ui, sans-serif';
  const levels = [1100, 1112.5, 1125, 1137.5];
  levels.forEach((lv, k) => {
    const y = H - 30 - k * ((H - 60) / (levels.length - 1));
    const tip = valley ? -28 : 28;
    g.beginPath();
    g.moveTo(20, y);
    g.lineTo(W / 2 - 40, y);
    g.quadraticCurveTo(W / 2 - 10, y + tip * 0.2, W / 2, y + tip);
    g.quadraticCurveTo(W / 2 + 10, y + tip * 0.2, W / 2 + 40, y);
    g.lineTo(W - 20, y);
    g.stroke();
    g.fillText(String(lv).replace('.', ','), 24, y - 5);
  });
  g.fillStyle = '#1d1d1b';
  g.beginPath();
  g.moveTo(W / 2, 4); g.lineTo(W / 2 + 7, 16); g.lineTo(W / 2 - 7, 16); g.closePath();
  g.fill();
  g.font = '600 11px system-ui, sans-serif';
  g.fillText('Puncak', W / 2 + 11, 14);
  // The dot sits on the axis of the Vs, halfway between the bends of the second and third contour.
  const step = (H - 60) / (levels.length - 1);
  const y = H - 30 - 1.5 * step + (valley ? -28 : 28);
  g.fillStyle = '#d2322d';
  g.strokeStyle = '#ffffff';
  g.lineWidth = 2;
  g.beginPath();
  g.arc(W / 2, y, 6, 0, Math.PI * 2);
  g.fill();
  g.stroke();
}
