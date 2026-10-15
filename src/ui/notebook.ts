// Field notebook (GDD addition): logs compass readings, pairing with map symbols, back azimuths the
// player works out by hand (checked against the rule in the material), and mission notes.
import type { Reading } from '../game/state';
import { SMOKE_TARGET } from '../game/state';
import { backAzimuth } from '../tools/sight';

export class Notebook {
  readings: Reading[] = [];
  notes: string[] = [];
  canWrite = true;
  /** Called when the player wants to pair reading `i` with a map symbol. */
  onPair: (i: number) => void = () => {};
  /** Called whenever the player edits something. */
  onChange: () => void = () => {};
  /** Names of map symbols by id. */
  symbolName: (id: number) => string = () => '?';

  constructor(private panel: HTMLElement, private body: HTMLElement) {}

  open() {
    this.render();
    this.panel.hidden = false;
  }

  close() {
    this.panel.hidden = true;
  }

  isOpen() { return !this.panel.hidden; }

  reset() {
    this.readings = [];
    this.notes = [];
  }

  /** True if the player's typed back azimuth for this reading follows the rule. */
  static backOk(r: Reading): boolean {
    return r.backTyped !== null && Math.abs(r.backTyped - backAzimuth(r.azimuth)) < 0.5;
  }

  render() {
    const b = this.body;
    b.replaceChildren();
    const h = (tag: string, text: string, cls = '') => {
      const e = document.createElement(tag);
      e.textContent = text;
      if (cls) e.className = cls;
      return e;
    };
    b.append(h('h3', 'Bidikan kompas'));
    if (this.readings.length === 0) b.append(h('p', 'Belum ada bidikan. Tahan tombol Kompas, bidik, lalu lepas.', 'muted'));
    if (!this.canWrite) b.append(h('p', 'Tidak membawa pena atau pensil: catatan tidak bisa ditulis.', 'warn'));
    this.readings.forEach((r, i) => {
      const row = document.createElement('div');
      row.className = 'nb-row';
      const what = r.target === SMOKE_TARGET ? 'asap' : r.target >= 0 ? 'titik ekstrem' : 'tanpa sasaran';
      row.append(h('span', `#${i + 1}`, 'nb-n'), h('span', `${String(r.azimuth).padStart(3, '0')}°`, 'nb-az'), h('span', what, 'nb-what'));
      const pair = document.createElement('button');
      pair.className = 'btn ghost small';
      pair.textContent = r.pairedWith >= 0 ? `= ${this.symbolName(r.pairedWith)}` : 'Pasangkan…';
      pair.disabled = !this.canWrite;
      pair.addEventListener('click', () => this.onPair(i));
      row.append(pair);
      const lab = h('label', 'Az. balik', 'nb-lab');
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.inputMode = 'decimal';
      inp.className = 'nb-input';
      inp.disabled = !this.canWrite;
      inp.value = r.backTyped === null ? '' : String(r.backTyped);
      const mark = h('span', '', 'nb-check');
      const showMark = () => {
        if (r.backTyped === null) mark.textContent = '';
        else if (Notebook.backOk(r)) { mark.textContent = '✓'; mark.className = 'nb-check ok'; }
        else { mark.textContent = '✗'; mark.className = 'nb-check bad'; }
      };
      showMark();
      inp.addEventListener('change', () => {
        const v = parseFloat(inp.value.replace(',', '.'));
        r.backTyped = Number.isFinite(v) ? v : null;
        showMark();
        this.onChange();
      });
      lab.append(inp);
      row.append(lab, mark);
      b.append(row);
    });
    b.append(h('p', 'Aturan azimut balik: di bawah 180° tambah 180°, di atas 180° kurangi 180°, tepat 180° menjadi 0°.', 'muted'));
    if (this.notes.length) {
      b.append(h('h3', 'Catatan'));
      for (const n of this.notes) b.append(h('div', n, 'nb-note'));
    }
  }
}
