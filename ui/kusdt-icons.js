// kUSDT's drawings (KaPay iOS Views/Tokens/WalletTokens.swift TokenIcon / USDTMark, 3d126db): the
// USDT mark - the T's bar, its stem and the flat ring across it - in white on USDT green, drawn
// here rather than shipped as an image, with the small Kaspa logo at the corner: it's the bridged
// token on Kaspa, not USDT itself. Plus the few SF Symbols the kUSDT screens use, as the app's
// other icons are drawn (stroke, currentColor).

import kaspaLogoUrl from "./assets/kaspa-logo.png";

/** USDT green (iOS TokenIcon.green). */
export const USDT_GREEN = "#26A17B";

/** The coin icon at `size` px (iOS TokenIcon): the mark, and the Kaspa logo at 38 % bottom-right. */
export function kusdtCoinIconHtml(size = 40, { label = "" } = {}) {
  const s = Number(size) || 40;
  return `<span class="kusdt-coin" style="--kusdt-coin:${s}px"${label ? ` role="img" aria-label="${label}"` : ' aria-hidden="true"'}>
    <svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="50" fill="${USDT_GREEN}"/><path fill="#fff" d="M23 24h54v13H23z"/><path fill="#fff" d="M42.5 37h15v42h-15z"/><ellipse cx="50" cy="50" rx="33" ry="8.5" fill="none" stroke="#fff" stroke-width="5"/></svg>
    <img class="kusdt-coin-kaspa" src="${kaspaLogoUrl}" alt="">
  </span>`;
}

/** The Kaspa logo as a round icon (the Send chooser's Kaspa row). */
export function kaspaCoinIconHtml(size = 40) {
  return `<span class="kusdt-kaspa-coin" style="--kusdt-coin:${Number(size) || 40}px" aria-hidden="true"><img src="${kaspaLogoUrl}" alt=""></span>`;
}

const svg = (paths, extra = "") => `<svg viewBox="0 0 24 24" aria-hidden="true"${extra}>${paths}</svg>`;

export const KUSDT_ICONS = {
  // dollarsign.circle
  dollarCircle: svg('<circle cx="12" cy="12" r="9.2"/><path d="M14.8 9.2c-.4-1-1.5-1.6-2.8-1.6-1.6 0-2.8.8-2.8 2.1 0 2.8 5.8 1.5 5.8 4.4 0 1.3-1.3 2.2-3 2.2-1.4 0-2.6-.7-3-1.8M12 6v1.6M12 16.3V18"/>'),
  chevronRight: svg('<path d="m9 6 6 6-6 6"/>'),
  chevronLeft: svg('<path d="M15 5 8 12l7 7"/>'),
  info: svg('<circle cx="12" cy="12" r="9.2"/><path d="M12 11v5.5M12 7.6v.1"/>'),
  ellipsisVertical: svg('<circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/>'),
  ellipsis: svg('<circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/>'),
  // slider.horizontal.3, Manage Addresses' actions button
  sliders: svg('<path d="M3 6h11M18 6h3M3 12h3M10 12h11M3 18h9M16 18h5"/><circle cx="16" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="14" cy="18" r="2"/>'),
  refresh: svg('<path d="M19.4 12.6A7.5 7.5 0 1 1 17 6.6"/><path d="M19.6 3.8v4.6H15"/>'),
  chat: svg('<path d="M2.5 6.5A2.5 2.5 0 0 1 5 4h8.5A2.5 2.5 0 0 1 16 6.5v3A2.5 2.5 0 0 1 13.5 12H7.5L4 15v-3.2A2.5 2.5 0 0 1 2.5 9.5Z"/><path d="M10.5 11.5A2.5 2.5 0 0 1 13 9h6.5A2.5 2.5 0 0 1 22 11.5v3A2.5 2.5 0 0 1 19.5 17h-3L13 20v-3h0a2.5 2.5 0 0 1-2.5-2.5Z"/>'),
  eyeSlash: svg('<path d="M3.5 3.5l17 17"/><path d="M9.9 5.3A9.7 9.7 0 0 1 12 5c5 0 8.5 4.6 9.5 7-.4 1-1.3 2.4-2.6 3.7M6.2 6.7C4.3 8 3 10 2.5 12c1 2.4 4.5 7 9.5 7 1.6 0 3-.4 4.3-1.1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>'),
  arrowDown: svg('<circle cx="12" cy="12" r="9.2"/><path d="M12 7.5v9M8 12.5l4 4 4-4"/>'),
  arrowUp: svg('<circle cx="12" cy="12" r="9.2"/><path d="M12 16.5v-9M8 11.5l4-4 4 4"/>'),
  merge: svg('<path d="M8 4v6a4 4 0 0 0 4 4v6M16 4v6a4 4 0 0 1-4 4"/><path d="m9 17 3 3 3-3"/>'),
  openExternal: svg('<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>'),
  qr: svg('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v3M14 20h3M20 18v3"/>'),
  send: svg('<circle cx="12" cy="12" r="9"/><path d="M12 16V8M8 12l4-4 4 4"/>'),
  sealCheck: svg('<path d="m12 2.8 2.2 1.6 2.7-.2.9 2.6 2.3 1.4-.6 2.6.9 2.6-2.3 1.4-.9 2.6-2.7-.2L12 21.2l-2.2-1.6-2.7.2-.9-2.6-2.3-1.4.9-2.6-.9-2.6 2.3-1.4.9-2.6 2.7.2z"/><path d="m8.8 12.2 2.2 2.2 4.2-4.4"/>'),
  safari: svg('<circle cx="12" cy="12" r="9.2"/><path d="m15.8 8.2-2.4 5.2-5.2 2.4 2.4-5.2z"/>'),
  warning: svg('<path d="M12 3.5 2.5 20h19L12 3.5Z"/><path d="M12 10v4.5M12 17.2v.1"/>'),
  clock: svg('<circle cx="12" cy="12" r="9.2"/><path d="M12 7v5l3 2"/>'),
  plusSquares: svg('<rect x="8" y="8" width="13" height="13" rx="2.5"/><path d="M16 8V5.5A2.5 2.5 0 0 0 13.5 3h-8A2.5 2.5 0 0 0 3 5.5v8A2.5 2.5 0 0 0 5.5 16H8M14.5 11.5v6M11.5 14.5h6"/>'),
  magnifier: svg('<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/>'),
  checklist: svg('<path d="m3.5 6.5 1.6 1.6 3-3M3.5 13.5l1.6 1.6 3-3M11 7h9.5M11 14h9.5M11 20h9.5"/>'),
  wallet: svg('<rect x="3" y="5.5" width="18" height="14" rx="2.5"/><path d="M3 9.5h18M16 14.5h2"/>'),
  hexagons: svg('<circle cx="7" cy="7" r="3.2"/><circle cx="17" cy="7" r="3.2"/><circle cx="12" cy="16" r="3.2"/>'),
  swap: svg('<path d="M4.5 9.5A7.5 7.5 0 0 1 18 6.5M19.5 14.5A7.5 7.5 0 0 1 6 17.5"/><path d="M18.5 3v4h-4M5.5 21v-4h4"/>'),
  checkCircle: svg('<circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><path d="m7.5 12.5 3 3 6-6.5" stroke="var(--kusdt-check-ink, #000)"/>'),
  circle: svg('<circle cx="12" cy="12" r="9.2"/>'),
  person: svg('<circle cx="12" cy="8.5" r="3.6"/><path d="M5 19.5c.9-3.4 3.6-5.3 7-5.3s6.1 1.9 7 5.3"/>'),
  shield: svg('<path d="M12 2.2 4 5.3v6.2c0 5 3.4 9.3 8 10.5 4.6-1.2 8-5.5 8-10.5V5.3Z"/>'),
  octagonX: svg('<path d="M8.2 3h7.6L21 8.2v7.6L15.8 21H8.2L3 15.8V8.2Z"/><path d="m9.2 9.2 5.6 5.6M14.8 9.2l-5.6 5.6"/>'),
  checkSmall: svg('<circle cx="12" cy="12" r="9.2"/><path d="m8 12.4 2.6 2.6L16 9.6"/>'),
  arrowToLine: svg('<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 20h14"/>'),
};

/** A receive note's icon (iOS ReceiveNote.icon). */
export function receiveNoteIcon(kind) {
  switch (kind) {
    case "allowed": return KUSDT_ICONS.checkSmall;
    case "warning": return KUSDT_ICONS.octagonX;
    case "privateAddress": return KUSDT_ICONS.eyeSlash;
    case "publicAddress": return KUSDT_ICONS.person;
    case "quantum": return KUSDT_ICONS.shield;
    default: return KUSDT_ICONS.info;
  }
}
