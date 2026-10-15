// Step counting (pacing). Each step covers a stride that gets shorter uphill and in thick vegetation,
// so the same 100 m takes more steps there (GDD "Pacing": terrain effect).
import { BLOCK_M } from '../gen/constants';

export const DEFAULT_PACE = 133; // steps per 100 m with a 0.75 m stride on flat ground

export class PaceCounter {
  /** Total steps since the last reset. */
  steps = 0;
  /** Manual tally (for detours), reset by the player. */
  tally = 0;
  /** Path length walked since the last reset, in metres. */
  metres = 0;
  running = true;

  reset() {
    this.steps = 0;
    this.tally = 0;
    this.metres = 0;
  }

  /**
   * Adds movement: `dist` horizontal blocks, `rise` blocks climbed (negative = down),
   * `brush` true in thick vegetation, `sprint` true when running.
   */
  add(dist: number, rise: number, brush: boolean, sprint: boolean) {
    if (!this.running || dist <= 0) return;
    const m = dist * BLOCK_M;
    const grade = rise / dist;
    let stride = sprint ? 1.05 : 0.75;
    // Uphill shortens the stride (about 12% on a 25% grade), downhill a little; thick vegetation ~10%.
    if (grade > 0) stride *= 1 - Math.min(0.25, grade * 0.5);
    else stride *= 1 - Math.min(0.08, -grade * 0.15);
    if (brush) stride *= 0.9;
    const s = m / stride;
    this.steps += s;
    this.tally += s;
    this.metres += m;
  }
}
