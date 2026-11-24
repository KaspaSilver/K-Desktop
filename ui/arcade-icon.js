// A KaPlay arcade game's mark (K 518fdc8c ArcadeGameIcon): Snake's symbol, and 2048 as the number
// itself (owner, 2026-11-24). Shared by KaPlay's cards (ui/chess-tournaments.js, ui/arcade.js) and
// KaPost's challenge card (ui/kaposts.js). Styled in ui/arcade.css (.arcade-icon-*), which
// ui/arcade.js loads; the icon inherits `color`.

const SNAKE_SVG = `<svg class="arcade-icon-snake" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 17.5c0 2 1.6 3 3.5 3s3.5-1.3 3.5-3.2V8.2C10.5 6.4 11.9 5 13.7 5s3.2 1.4 3.2 3.2v.6"/><path d="M16.9 8.8c0 1.4 1.2 2.4 2.6 2.4"/><circle cx="19.6" cy="11.4" r="1.4" fill="currentColor" stroke="none"/><path d="M3.5 17.5V14"/></svg>`;

/** The game's icon as HTML. */
export function arcadeIconHtml(game) {
  if (game === "2048") return `<span class="arcade-icon-2048" aria-hidden="true">2048</span>`;
  return SNAKE_SVG;
}
