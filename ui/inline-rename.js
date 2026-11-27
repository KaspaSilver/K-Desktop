// Rename in place on an address card (K b49a021d InlineRename / InlineRenameField; owner,
// 2026-11-27: "no pop-up"). Rename turns the card's name into a text field with the cursor in it,
// the quantum tag steps aside and the Rename button reads Done. The name is saved once, when Enter,
// Done or a click elsewhere ends it (K d88891ea M6/L20: saving each keystroke left a cleared
// account name as its first letter, and redrew on every key); an empty name goes back to the
// default; Escape ends it without saving.
//
// Used by Manage Addresses, Manage kUSDT and Cold Storage. A list that repaints on a timer checks
// inlineRenameActive() first, so the field isn't wiped while it's typed in; onDone repaints it.

const CHECK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';

let active = null;
// The card whose rename ended last, by key: the click on Done lands after the blur has ended it,
// often on a card the list has just drawn again, and must not start another.
let lastEnded = { key: "", at: 0 };

/** A card's name is being typed right now. */
export function inlineRenameActive() {
  return Boolean(active && active.card.isConnected);
}

/** The rename of the card with this key ended a moment ago. */
export function inlineRenameJustEnded(key) {
  return Boolean(key) && lastEnded.key === key && Date.now() - lastEnded.at < 400;
}

/**
 * Starts renaming `card` (an `.address-card`): its `.address-card-name` becomes a field, its
 * `[data-rename-button]` reads Done. A second call on the same card ends it. `key` names the card
 * across repaints (e.g. "spending:3").
 * @param {HTMLElement} card
 * @param {{ key: string, current?: string, placeholder?: string, onChange?: (text: string) => void, onDone?: () => void }} options
 */
export function startInlineRename(card, { key = "", current = "", placeholder = "", onChange, onDone } = {}) {
  if (!card) return;
  if (active && (active.card === card || (key && active.key === key))) { active.finish(); return; }
  if (inlineRenameJustEnded(key)) return;
  active?.finish();
  const nameEl = card.querySelector(".address-card-name");
  if (!nameEl) return;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "address-card-rename-input";
  input.value = current;
  input.placeholder = placeholder;
  input.maxLength = 64;
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("autocapitalize", "words");
  input.setAttribute("aria-label", "Address name");
  nameEl.hidden = true;
  nameEl.after(input);
  card.classList.add("renaming");

  const button = card.querySelector("[data-rename-button]");
  const buttonHtml = button?.innerHTML;
  if (button) {
    button.innerHTML = `<span class="address-card-action-circle">${CHECK_ICON}</span><span>Done</span>`;
    button.setAttribute("aria-label", "Done");
  }

  // The card's body opens the address's history on a click or Enter: not while typing in it.
  const stop = (event) => event.stopPropagation();
  let cancelled = false;
  const onKey = (event) => {
    event.stopPropagation();
    if (event.key === "Escape") cancelled = true;
    if (event.key === "Enter" || event.key === "Escape") { event.preventDefault(); input.blur(); }
  };
  input.addEventListener("click", stop);
  input.addEventListener("pointerdown", stop);
  input.addEventListener("keydown", onKey);

  const session = {
    card,
    key,
    finish() {
      if (active !== session) return;
      active = null;
      input.removeEventListener("blur", session.finish);
      lastEnded = { key, at: Date.now() };
      // saved once, as it ends; Escape keeps the name it had
      if (!cancelled && input.value !== current) { try { onChange?.(input.value); } catch { /* the name stays as it was */ } }
      card.classList.remove("renaming");
      input.remove();
      nameEl.hidden = false;
      if (button) { button.innerHTML = buttonHtml; button.removeAttribute("aria-label"); }
      try { onDone?.(); } catch { /* the next repaint shows it */ }
    },
  };
  input.addEventListener("blur", session.finish);
  active = session;
  input.focus();
  input.select();
}
