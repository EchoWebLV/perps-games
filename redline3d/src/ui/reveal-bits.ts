// Pure markup helpers for the crate reveal. No DOM side effects and no <style> injection
// (cratebox.ts owns the reveal CSS) so these stay trivially unit-testable.

/** the level-skin poster's palette, pulled from a WorldTheme (see main.ts levelInfo). */
export interface LevelPoster { name: string; sky: [string, string]; disc: string; grid: [string, string]; }

/** how many shards the scrap heap draws for an amount — a stepped, clamped feel. */
export function pileShards(n: number): number {
  if (n <= 0) return 0;
  if (n < 100) return 4;
  if (n < 400) return 6;
  if (n < 900) return 8;
  return 10;
}

/** a little pile of steel shards + the amount. Shards are placed deterministically by index
 *  (no RNG → stable in tests); actual look comes from the .cb-shard CSS in cratebox. */
export function scrapPileHtml(n: number): string {
  const count = pileShards(n);
  let shards = "";
  for (let i = 0; i < count; i++) {
    const col = i % 3 === 0 ? "#d7dee7" : i % 3 === 1 ? "#c2cad6" : "#8b93a0";
    const x = ((i * 37) % 70) - 35;            // −35..35 px spread, deterministic
    const y = (i % 3) * 6;                      // 0/6/12 px stacking
    const rot = ((i * 53) % 90) - 45;           // −45..45 deg
    const sz = 12 + (i % 3) * 4;                // 12/16/20 px
    shards += `<span class="cb-shard" style="--sc:${col};left:calc(50% + ${x}px);bottom:${y}px;width:${sz}px;height:${sz}px;transform:translateX(-50%) rotate(${rot}deg)"></span>`;
  }
  return `<div class="cb-scrap"><div class="cb-scrap-heap">${shards}</div><div class="cb-scrap-n">+${n}</div><div class="cb-scrap-lbl">scrap</div></div>`;
}

/** a mini world-poster card built from the theme palette. */
export function levelPosterHtml(info: LevelPoster): string {
  return (
    `<div class="cb-poster">` +
      `<div class="cb-poster-sky" style="background:linear-gradient(180deg,${info.sky[0]},${info.sky[1]})">` +
        `<span class="cb-poster-disc" style="background:${info.disc}"></span>` +
        `<span class="cb-poster-grid" style="background:${info.grid[1]}"></span>` +
        `<span class="cb-poster-grid low" style="background:${info.grid[0]}"></span>` +
      `</div>` +
      `<div class="cb-poster-body"><div class="cb-poster-nm">${info.name}</div><div class="cb-poster-tag">NEW LEVEL</div></div>` +
    `</div>`
  );
}
