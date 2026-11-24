// The cycle button (K 518fdc8c CycleCapsuleButton / PageCycleBar, ActionSheet.swift): one
// see-through capsule with an accent border that steps through a few choices. Each click fades to
// the next choice, and round again after the last. Dots say which one it is (six choices or fewer),
// or "3/14" past that. It replaced every page tab and segmented page switch inside a screen (owner,
// 2026-11-24): KaPost's feeds, a profile's Posts / Replies, an address's pages, Stats, Swap, Chess,
// KaPost Search and every leaderboard's This month / All time. No sideways swipe goes with it.
//
// No DOM at import time and no CSS import (ui/cycle-button.css comes in through ui/app.js), so the
// node tests can load it. A screen renders `cycleButtonHtml(...)` and handles the click in its own
// delegated listener: `data-cycle-next` on the button is the choice to switch to. The arrow keys
// step too (right / down: next, left / up: back), through one document listener.

const ICON = `<svg class="cycle-button-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 10.5A7.6 7.6 0 0 1 18 6.8l1.6 1.7"/><path d="M19.8 4.2v4.5h-4.5"/><path d="M19.5 13.5A7.6 7.6 0 0 1 6 17.2l-1.6-1.7"/><path d="M4.2 19.8v-4.5h4.5"/></svg>`;

/** Up to this many choices show dots; more show "3/14" (K: `options.count <= 6`). */
export const CYCLE_DOTS_MAX = 6;

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Choices as [{ id, title }]: [id, title] pairs and plain strings are taken too. */
export function cycleOptions(options) {
  return (Array.isArray(options) ? options : []).map((option) => {
    if (Array.isArray(option)) return { id: String(option[0]), title: String(option[1] ?? option[0]) };
    if (option && typeof option === "object") return { id: String(option.id), title: String(option.title ?? option.id) };
    return { id: String(option), title: String(option) };
  });
}

/** Where `value` is among the choices; the first one when it isn't there. */
export function cycleIndex(options, value) {
  const list = cycleOptions(options);
  const index = list.findIndex((option) => option.id === String(value));
  return index < 0 ? 0 : index;
}

/** The choice after `value`, back to the first after the last (`step` -1: the one before). */
export function cycleNextValue(options, value, step = 1) {
  const list = cycleOptions(options);
  if (!list.length) return null;
  const index = list.findIndex((option) => option.id === String(value));
  const from = index < 0 ? (step > 0 ? -1 : 0) : index;
  return list[(((from + step) % list.length) + list.length) % list.length].id;
}

/** Where it is: dots up to six choices, "3/14" past that. */
export function cyclePosition(options, value) {
  const list = cycleOptions(options);
  const index = cycleIndex(list, value);
  return list.length <= CYCLE_DOTS_MAX
    ? { kind: "dots", index, count: list.length }
    : { kind: "text", index, count: list.length, text: `${index + 1}/${list.length}` };
}

/** What a screen reader says: the choice, where it is, and what a click does. */
export function cycleAccessibleLabel(options, value, hint = "Switches to the next page") {
  const list = cycleOptions(options);
  const index = cycleIndex(list, value);
  const title = list[index]?.title || "";
  return `${title}, ${index + 1} of ${list.length}. ${hint}`;
}

// What each button showed last, so a repaint fades only when the choice changed (a screen that
// repaints on a timer doesn't blink its button).
const lastShown = new Map();

/** True once per change of `value` under `key` (never the first time a key is seen). A screen can
 *  use it to fade its page in after a click: `cycleChanged("stats-page", page) ? " cycle-fade" : ""`. */
export function cycleChanged(key, value) {
  const k = String(key);
  const v = String(value);
  const had = lastShown.has(k);
  const before = lastShown.get(k);
  lastShown.set(k, v);
  return had && before !== v;
}

/** The inside of the button: the icon, the title, the dots or "n/m". */
export function cycleButtonInnerHtml(options, value) {
  const list = cycleOptions(options);
  const index = cycleIndex(list, value);
  const position = cyclePosition(list, value);
  const marker = position.kind === "dots"
    ? `<span class="cycle-button-dots" aria-hidden="true">${list.map((_, i) => `<i${i === index ? ' class="on"' : ""}></i>`).join("")}</span>`
    : `<span class="cycle-button-count" aria-hidden="true">${position.text}</span>`;
  return `${ICON}<span class="cycle-button-title">${escapeHtml(list[index]?.title || "")}</span>${marker}`;
}

/**
 * The button as HTML.
 * - `name`: which switch it is, as `data-cycle` (a screen's listener matches on it).
 * - `options`: the choices, in order; `value`: the one showing.
 * - `hint`: what a click does ("Switches to the next page", K's hint).
 * - `attrs`: more attributes (a screen's own data-* hook), already escaped.
 */
export function cycleButtonHtml({ name, options, value, hint = "Switches to the next page", className = "", attrs = "" }) {
  const list = cycleOptions(options);
  const current = list[cycleIndex(list, value)]?.id ?? "";
  const fade = cycleChanged(`button:${name}`, current);
  return `<button type="button" class="cycle-button${className ? ` ${className}` : ""}${fade ? " cycle-changed" : ""}" data-cycle="${escapeHtml(name)}"`
    + ` data-cycle-value="${escapeHtml(current)}" data-cycle-next="${escapeHtml(cycleNextValue(list, current) ?? "")}"`
    + ` data-cycle-prev="${escapeHtml(cycleNextValue(list, current, -1) ?? "")}"`
    + ` aria-label="${escapeHtml(cycleAccessibleLabel(list, current, hint))}" title="${escapeHtml(hint)}"${attrs ? ` ${attrs}` : ""}>`
    + `${cycleButtonInnerHtml(list, current)}</button>`;
}

/** The same button, a row of its own above what it switches (K PageCycleBar). */
export function cycleBarHtml(args) {
  return `<div class="cycle-bar">${cycleButtonHtml(args)}</div>`;
}

/** Puts a button that lives in the page (not re-rendered) on `value`, fading its title. */
export function updateCycleButton(button, { options, value, hint = "Switches to the next page" }) {
  if (!button) return;
  const list = cycleOptions(options);
  const current = list[cycleIndex(list, value)]?.id ?? "";
  const changed = button.dataset.cycleValue !== undefined && button.dataset.cycleValue !== current;
  button.dataset.cycleValue = current;
  button.dataset.cycleNext = cycleNextValue(list, current) ?? "";
  button.dataset.cyclePrev = cycleNextValue(list, current, -1) ?? "";
  button.setAttribute("aria-label", cycleAccessibleLabel(list, current, hint));
  button.title = hint;
  button.innerHTML = cycleButtonInnerHtml(list, current);
  if (changed) restartFade(button, "cycle-changed");
}

/** Fades `el` in again (the page under a cycle button, after a click). */
export function restartFade(el, className = "cycle-fade") {
  if (!el?.classList) return;
  el.classList.remove(className);
  void el.offsetWidth; // the class comes off before it goes back on, so the fade runs again
  el.classList.add(className);
}

// The keyboard: Enter and Space are the button's own. The arrows step forward and back. A click
// after swapping `data-cycle-next` for `data-cycle-prev` sends "back" through the screen's own
// click listener. A screen that paints itself again on the click replaces the button, so the focus
// moves to the new one (a keyboard user stays on it).
function refocus(button, name) {
  if (button.isConnected) return;
  const sel = `button.cycle-button[data-cycle="${globalThis.CSS?.escape ? CSS.escape(name) : name}"]`;
  const again = [...document.querySelectorAll(sel)].find((el) => el.offsetParent !== null) || document.querySelector(sel);
  again?.focus();
}
if (typeof document !== "undefined" && typeof document.addEventListener === "function" && !globalThis.__kCycleKeys) {
  globalThis.__kCycleKeys = true;
  document.addEventListener("click", (event) => {
    const button = event.target?.closest?.("button.cycle-button[data-cycle]");
    if (!button || document.activeElement !== button) return;
    const name = button.dataset.cycle;
    window.setTimeout(() => refocus(button, name), 0);
  }, true);
  document.addEventListener("keydown", (event) => {
    const button = event.target?.closest?.("button.cycle-button[data-cycle]");
    if (!button || event.altKey || event.ctrlKey || event.metaKey) return;
    const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
    const backward = event.key === "ArrowLeft" || event.key === "ArrowUp";
    if (!forward && !backward) return;
    event.preventDefault();
    if (backward) {
      const before = button.dataset.cycleValue;
      const next = button.dataset.cycleNext;
      button.dataset.cycleNext = button.dataset.cyclePrev || next;
      button.click();
      // still the same choice (nothing took the click): put "next" back
      if (button.isConnected && button.dataset.cycleValue === before) button.dataset.cycleNext = next;
    } else button.click();
  });
}
