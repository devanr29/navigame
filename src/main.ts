import './style.css';
import logoUrl from '../assets/logo-jamadagni.png';
import type { WorldData } from './gen/constants';
import type { Sites } from './game/sites';
import { enterFullscreen, Game } from './game/game';

const params = new URLSearchParams(location.search);
const seed = params.get('seed') || 'jamadagni';
const debug = params.has('debug');

const $ = (id: string) => document.getElementById(id) as HTMLElement;
($('logo') as HTMLImageElement).src = logoUrl;
$('seed').textContent = `seed: ${seed}`;

function setProgress(stage: string, frac: number) {
  $('stage').textContent = stage;
  $('bar-fill').style.width = `${Math.round(frac * 100)}%`;
}

function generate(): Promise<{ world: WorldData; sites: Sites }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./gen/worker.ts', import.meta.url), { type: 'module' });
    const stages = ['Membentuk relief', 'Mengalirkan sungai', 'Menempatkan titik ekstrem', 'Membuka jalan setapak', 'Menanam pohon', 'Menyiapkan misi'];
    worker.onmessage = (e) => {
      if (e.data.type === 'progress') {
        const k = Math.max(0, stages.indexOf(e.data.stage));
        setProgress(`${e.data.stage}…`, ((k + e.data.frac) / stages.length) * 0.8);
      } else if (e.data.type === 'done') {
        worker.terminate();
        resolve({ world: e.data.world, sites: e.data.sites });
      }
    };
    worker.onerror = (e) => reject(e);
    worker.postMessage({ seed });
  });
}

async function boot() {
  const { world, sites } = await generate();
  const lv = debug ? Number(params.get('level')) : NaN;
  const game = new Game(world, sites, {
    debug,
    debugLevel: Number.isInteger(lv) && lv >= 1 && lv <= 10 ? lv : null,
    logoUrl,
  });
  await game.preload(world.spawn[0], world.spawn[1], (f) => setProgress('Membangun dunia blok…', 0.8 + 0.2 * f));
  setProgress('Siap', 1);
  const startBtn = $('btn-start');
  startBtn.hidden = false;
  if (!(debug && params.has('autostart'))) {
    await new Promise<void>((resolve) => startBtn.addEventListener('click', () => resolve(), { once: true }));
  }
  await enterFullscreen();
  $('loading').hidden = true;
  await game.run();
}

boot().catch((err) => {
  console.error(err);
  setProgress(`Gagal memuat: ${err?.message ?? err}`, 0);
});
