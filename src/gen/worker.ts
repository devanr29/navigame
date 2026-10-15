// Runs world generation and mission-site selection off the main thread so the loading screen stays responsive.
import { generateWorld } from './world';
import { findSites } from '../game/sites';

self.onmessage = (e: MessageEvent<{ seed: string }>) => {
  const world = generateWorld(e.data.seed, (stage, frac) => self.postMessage({ type: 'progress', stage, frac }));
  self.postMessage({ type: 'progress', stage: 'Menyiapkan misi', frac: 0 });
  const sites = findSites(world);
  const transfer = [
    world.heightF.buffer, world.height.buffer, world.water.buffer, world.deck.buffer,
    world.solid.buffer, world.surface.buffer, world.zone.buffer, world.trees.buffer,
  ];
  (self as unknown as Worker).postMessage({ type: 'done', world, sites }, transfer);
};
