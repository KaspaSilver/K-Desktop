// The Usernames tab of an address screen - the chatting address, a spending address, a KasSigner
// address (K 518fdc8c AddressDomainsTab): the .kachat names that address holds, the only name
// service since 2026-11-23, with a refresh button above them.

let ctx = null;
const renders = new WeakMap();
let seq = 0;

/** `renderKachat(el, address)` (the .kachat cards and their detail screens) and `refreshKachat()`
 *  (the list's refresh: the registry). */
export function initAddressDomainsTab(deps) {
  ctx = deps;
}

const REFRESH = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19.4 12.6A7.5 7.5 0 1 1 17 6.6"/><path d="M19.6 3.8v4.6H15"/></svg>`;

/** The refresh button: the platform's stand-in for iOS's pull-to-refresh. */
function refreshHtml(state) {
  return `<button type="button" class="addr-domains-refresh${state.refreshing ? " spinning" : ""}" data-addr-domains-refresh
    aria-label="Refresh" title="Refresh" ${state.refreshing ? "disabled" : ""}>${REFRESH}</button>`;
}

function paint(state) {
  const root = state.el.querySelector(`[data-addr-domains="${state.token}"]`);
  if (!root) return;
  root.innerHTML = `<div class="addr-domains-bar">${refreshHtml(state)}</div><div data-addr-domains-body></div>`;
  ctx?.renderKachat?.(root.querySelector("[data-addr-domains-body]"), state.address);
}

/** The refresh button re-reads the registry (iOS KachatAddressLiveNamesList: registry.refresh),
 *  which reloads the list. */
async function refreshTab(state) {
  if (state.refreshing) return;
  state.refreshing = true;
  paintRefresh(state);
  try { await ctx?.refreshKachat?.(); } catch { /* the list says what it could read */ }
  state.refreshing = false;
  paintRefresh(state);
}
function paintRefresh(state) {
  if (renders.get(state.el) !== state) return;
  state.el.querySelectorAll(`[data-addr-domains="${state.token}"] [data-addr-domains-refresh]`).forEach((button) => {
    button.classList.toggle("spinning", state.refreshing);
    button.disabled = state.refreshing;
  });
}

/** Draws (or, for the same address, reloads in place) the Usernames tab into `el`. */
export function renderAddressDomainsTab(el, address) {
  if (!el || !address) return;
  const key = String(address).trim().toLowerCase();
  const previous = renders.get(el);
  if (previous && previous.address === key && el.querySelector(`[data-addr-domains="${previous.token}"]`)) {
    paint(previous);
    return;
  }
  const state = { el, address: key, token: String(++seq), refreshing: false };
  renders.set(el, state);
  el.innerHTML = `<div class="addr-domains" data-addr-domains="${state.token}"></div>`;
  paint(state);
  if (!el.dataset.addrDomainsBound) {
    el.dataset.addrDomainsBound = "1";
    el.addEventListener("click", (event) => {
      const current = renders.get(el);
      if (!current) return;
      const refresh = event.target.closest("[data-addr-domains-refresh]");
      if (refresh && el.contains(refresh)) refreshTab(current);
    });
  }
}
