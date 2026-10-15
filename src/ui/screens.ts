// Menu screens: title, level select, packing (Phase A step 1), map quiz (step 2), briefing, debrief,
// and a small number dialog. All built with DOM methods (no innerHTML).
import type { LevelInfo, Result } from '../game/missions';
import type { Question } from '../game/quiz';
import { DISTRACTORS, TOOLS, type Progress, type ToolId } from '../game/state';
import type { CharacterPreview } from './preview';

type Kids = (Node | string | null | false | undefined)[];

/** What went into the zipper bag: the navigation tools, and any non-navigation items packed by mistake. */
export interface Packed { tools: Set<ToolId>; extras: typeof DISTRACTORS }

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', ...kids: Kids): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids) if (k !== null && k !== false && k !== undefined) e.append(k);
  return e;
}

function btn(label: string, cls = 'btn', onClick?: () => void) {
  const b = el('button', cls, label);
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

export class Screens {
  constructor(private root: HTMLElement, private logoUrl: string, private preview: CharacterPreview) {}

  private show(...kids: Kids) {
    this.preview.stop();
    this.root.replaceChildren(...kids.filter((k): k is Node | string => !!k));
    this.root.hidden = false;
    this.root.scrollTop = 0;
  }

  hide() {
    this.preview.stop();
    this.root.hidden = true;
    this.root.replaceChildren();
  }

  title(): Promise<void> {
    return new Promise((resolve) => {
      const logo = el('img', 'logo-big');
      logo.src = this.logoUrl;
      logo.alt = 'Logo PPA Jamadagni';
      this.show(el('div', 'screen-center',
        logo,
        el('h1', '', 'Navigasi Darat'),
        el('p', 'muted', 'Latihan peta dan kompas · Perhimpunan Penjelajah Alam Jamadagni Bandung'),
        btn('Mulai', 'btn big', () => resolve()),
      ));
    });
  }

  levels(levels: LevelInfo[], p: Progress): Promise<number> {
    return new Promise((resolve) => {
      const grid = el('div', 'level-grid');
      for (const L of levels) {
        const locked = L.n > p.unlocked;
        const best = p.best[L.n];
        const card = el('button', `level-card${locked ? ' locked' : ''}`,
          el('div', 'lv-n', String(L.n)),
          el('div', 'lv-title', L.title),
          el('div', 'lv-focus', L.focus),
          el('div', 'lv-best', locked ? 'Terkunci' : best !== undefined ? `Skor terbaik ${best}` : 'Belum dimainkan'),
        );
        card.disabled = locked;
        card.addEventListener('click', () => resolve(L.n));
        grid.append(card);
      }
      this.show(el('div', 'screen-wrap',
        el('h2', '', 'Pilih level'),
        el('p', 'muted', 'Setiap level menambah satu keterampilan. Selesaikan level untuk membuka level berikutnya.'),
        grid,
        p.paceCount ? el('p', 'muted small', `Kalibrasi langkahmu: ${p.paceCount} langkah per 100 m.`) : null,
      ));
    });
  }

  /**
   * Packing screen. Each item is tapped into the zipper bag; a few items that are not navigation tools
   * are mixed in. Later levels offer a quick "pack all" (navigation tools only).
   */
  packing(level: LevelInfo, quick: boolean, rnd: () => number): Promise<Packed> {
    return new Promise((resolve) => {
      const packed = new Set<ToolId>();
      const extras = new Set<string>();
      const decoys = DISTRACTORS.map((d) => ({ d, r: rnd() })).sort((a, b) => a.r - b.r).slice(0, 4).map((x) => x.d);
      // Real tools and decoys in one shuffled list, so position gives nothing away.
      const items = [
        ...TOOLS.map((t) => ({ key: t.id as string, name: t.name, job: t.job, tool: t.id as ToolId | null })),
        ...decoys.map((d) => ({ key: `x:${d.name}`, name: d.name, job: d.job, tool: null })),
      ].map((it) => ({ it, r: rnd() })).sort((a, b) => a.r - b.r).map((x) => x.it);
      const has = (k: string, tool: ToolId | null) => (tool ? packed.has(tool) : extras.has(k));
      const pouch = el('div', 'pouch');
      const table = el('div', 'pack-items');
      const render = () => {
        table.replaceChildren();
        pouch.replaceChildren(el('div', 'pouch-title', `Zipper · ${packed.size + extras.size} barang`));
        for (const t of items) {
          const inBag = has(t.key, t.tool);
          const item = el('button', `pack-item${inBag ? ' in' : ''}`, el('b', '', t.name), el('span', '', t.job));
          item.addEventListener('click', () => {
            if (t.tool) { if (packed.has(t.tool)) packed.delete(t.tool); else packed.add(t.tool); }
            else if (extras.has(t.key)) extras.delete(t.key);
            else extras.add(t.key);
            go.dataset.warned = '';
            warn.textContent = '';
            render();
          });
          (inBag ? pouch : table).append(item);
        }
      };
      const go = btn('Berangkat', 'btn big', () => {
        const missing = TOOLS.filter((t) => !packed.has(t.id));
        if (missing.length && !go.dataset.warned) {
          go.dataset.warned = '1';
          warn.textContent = `Belum dikemas: ${missing.map((t) => t.name).join(', ')}. Boleh berangkat, tetapi alat itu tidak bisa dipakai di lapangan. Tekan Berangkat lagi untuk lanjut.`;
          return;
        }
        resolve({ tools: packed, extras: DISTRACTORS.filter((d) => extras.has(`x:${d.name}`)) });
      });
      const warn = el('p', 'warn', '');
      render();
      this.show(el('div', 'screen-wrap',
        el('h2', '', `Level ${level.n} · Kemas alat`),
        el('p', 'muted', 'Ketuk alat navigasi darat untuk memasukkannya ke zipper. Tidak semua barang di meja adalah alat navigasi. Alat yang tertinggal tidak bisa dipakai di lapangan.'),
        el('div', 'pack-wrap', table, pouch),
        warn,
        el('div', 'row',
          quick ? btn('Kemas alat navigasi', 'btn ghost', () => { for (const t of TOOLS) packed.add(t.id); extras.clear(); render(); }) : null,
          go),
      ));
    });
  }

  /** Map quiz. Wrong answers can be retried; returns how many were right on the first try. */
  quiz(title: string, qs: Question[], openMap: () => Promise<void>): Promise<{ firstTry: number; total: number }> {
    return new Promise((resolve) => {
      let k = 0;
      let firstTry = 0;
      let tried = false;
      const next = () => {
        if (k >= qs.length) { resolve({ firstTry, total: qs.length }); return; }
        const q = qs[k];
        tried = false;
        const fb = el('p', 'feedback', '');
        const opts = el('div', 'quiz-opts');
        q.options.forEach((o, i) => {
          const b = btn(o, 'btn ghost quiz-opt', () => {
            if (i === q.answer) {
              if (!tried) firstTry++;
              b.classList.add('right');
              fb.textContent = 'Benar!';
              fb.className = 'feedback ok';
              for (const x of opts.querySelectorAll('button')) (x as HTMLButtonElement).disabled = true;
              setTimeout(() => { k++; next(); }, 700);
            } else {
              tried = true;
              b.classList.add('wrong');
              b.disabled = true;
              fb.textContent = 'Belum tepat. Periksa lagi di peta, lalu coba lagi.';
              fb.className = 'feedback bad';
            }
          });
          opts.append(b);
        });
        let fig: HTMLCanvasElement | null = null;
        if (q.diagram) {
          fig = el('canvas', 'quiz-fig');
          fig.width = 280;
          fig.height = 150;
          q.diagram(fig);
        }
        this.show(el('div', 'screen-wrap',
          el('h2', '', title),
          el('p', 'muted', `Soal ${k + 1} dari ${qs.length}`),
          el('p', 'quiz-q', q.text),
          fig,
          q.usesMap ? btn('Buka peta', 'btn ghost', () => void openMap()) : null,
          opts,
          fb,
        ));
      };
      next();
    });
  }

  briefing(level: LevelInfo, paragraphs: string[], extra: string[]): Promise<void> {
    return new Promise((resolve) => {
      this.show(el('div', 'screen-wrap brief',
        el('div', 'brief-text',
          el('h2', '', `Level ${level.n} · ${level.title}`),
          el('p', 'muted', `Fokus: ${level.focus}. Lulus jika: ${level.pass}.`),
          ...paragraphs.map((p) => el('p', '', p)),
          ...extra.map((p) => el('p', 'warn', p)),
          btn('Lanjut', 'btn big', () => resolve()),
        ),
        this.preview.canvas,
      ));
      this.preview.start();
    });
  }

  debrief(level: LevelInfo, r: Result, missing: string[], hasNext: boolean, onMap: () => Promise<void>): Promise<'retry' | 'next' | 'menu'> {
    return new Promise((resolve) => {
      const stats = el('table', 'stats');
      for (const [k, v] of r.stats) stats.append(el('tr', '', el('td', '', k), el('td', '', v)));
      this.show(el('div', 'screen-wrap brief',
        el('div', 'brief-text',
          el('h2', '', `Level ${level.n} · ${r.passed ? 'Berhasil' : 'Belum lulus'}`),
          el('div', `score ${r.passed ? 'ok' : 'bad'}`, `Skor ${r.score}`),
          stats,
          missing.length ? el('p', 'warn', `Alat yang tertinggal: ${missing.join(', ')}. Tindakan yang memakai alat itu tidak bisa dilakukan.`) : null,
          ...r.lessons.map((l) => el('p', 'lesson', l)),
          el('p', 'muted small', 'Memeriksa posisi tidak pernah mengurangi skor: sering mengecek adalah kebiasaan yang baik.'),
          el('div', 'row',
            btn('Lihat peta', 'btn ghost', () => void onMap()),
            btn('Ulangi', 'btn ghost', () => resolve('retry')),
            btn('Menu', 'btn ghost', () => resolve('menu')),
            hasNext && r.passed ? btn('Level berikutnya', 'btn', () => resolve('next')) : null,
          ),
        ),
        this.preview.canvas,
      ));
      this.preview.start();
    });
  }
}

/** Small modal with number inputs. */
export function askNumbers(
  host: HTMLElement, title: string, fields: { key: string; label: string; value?: number }[],
): Promise<Record<string, number> | null> {
  return new Promise((resolve) => {
    const inputs: Record<string, HTMLInputElement> = {};
    const form = el('div', 'dialog-box', el('h3', '', title));
    for (const f of fields) {
      const i = el('input', 'dialog-input');
      i.type = 'number';
      i.inputMode = 'decimal';
      if (f.value !== undefined) i.value = String(f.value);
      inputs[f.key] = i;
      form.append(el('label', '', f.label, i));
    }
    const done = (ok: boolean) => {
      host.hidden = true;
      host.replaceChildren();
      if (!ok) { resolve(null); return; }
      const out: Record<string, number> = {};
      for (const f of fields) out[f.key] = parseFloat(inputs[f.key].value.replace(',', '.'));
      resolve(out);
    };
    form.append(el('div', 'row', btn('Batal', 'btn ghost', () => done(false)), btn('Simpan', 'btn', () => done(true))));
    host.replaceChildren(form);
    host.hidden = false;
    inputs[fields[0].key]?.focus();
  });
}
