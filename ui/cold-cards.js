// Cold Storage on Manage Addresses' cards (K b49a021d, owner 2026-11-27): the rules behind the
// account cards on the list and the address cards inside an account. Pure (no DOM, no WASM, no
// network), so tools/test-ios-b49a021d-cold.mjs runs it as is; ui/coldstorage.js draws the cards.

/// Manage Addresses' order (K b49a021d ColdStorageDetailView): unused first, newest first, so a
/// freshly generated address lands at the top, then the used ones in number order. Regular
/// addresses come before quantum ones within each group. `isUsed(entry)` and `isQuantum(index)`
/// are the screen's own.
export function sortColdEntries(entries, isUsed, isQuantum) {
  return [...entries].sort((a, b) => {
    const aUsed = Boolean(isUsed(a));
    const bUsed = Boolean(isUsed(b));
    if (aUsed !== bUsed) return aUsed ? 1 : -1;
    const aQuantum = Boolean(isQuantum(a.index));
    const bQuantum = Boolean(isQuantum(b.index));
    if (aQuantum !== bQuantum) return aQuantum ? 1 : -1;
    return aUsed ? a.index - b.index : b.index - a.index;
  });
}

/// What an address card's Used / Unused tag says (K ManagedAddressCard used:): "used" when it was
/// ever used, holds Kaspa or holds a username; "checking" while its balance or history isn't known
/// (never a possibly-wrong "Unused"); "unused" only on a confirmed answer.
export function coldUsageState({ balanceSompi, everUsed, ownsUsername = false }) {
  if (everUsed === true || (Number(balanceSompi) || 0) > 0 || ownsUsername) return "used";
  if (balanceSompi === undefined || balanceSompi === null || everUsed === undefined || everUsed === null) return "checking";
  return "unused";
}

/// The quantum tag's tone (K QuantumProtection, as Manage Addresses tells it): a quantum address is
/// protected ("safe") until a spend puts its key on chain, then orange ("warn") while it holds Kaspa
/// again, gray ("plain") otherwise; a regular address is never protected.
export function coldQuantumTone({ quantum, spent, funded }) {
  if (!quantum) return "plain";
  if (!spent) return "safe";
  return funded ? "warn" : "plain";
}

/// Discover Addresses' result toast (K b49a021d discoverAddresses): the COUNT of addresses holding a
/// balance or a username, never "used".
export function coldDiscoverySummary(found) {
  const n = Math.max(0, Math.floor(Number(found) || 0));
  if (n === 0) return "No addresses with a balance or username found.";
  if (n === 1) return "Found 1 address with a balance or username.";
  return `Found ${n} addresses with a balance or username.`;
}

/// An account card's Rename, each keystroke (K b49a021d ColdStorageAccountCard): the typed name,
/// trimmed, or null to keep the old one when it's empty.
export function coldAccountRenameValue(text) {
  const trimmed = String(text ?? "").trim();
  return trimmed ? trimmed : null;
}

/// An account card's Alerts toggle toast (K b49a021d onToggleAlerts).
export function coldAlertsToast(on) {
  return on
    ? "You'll be notified when this account receives Kaspa."
    : "No more notifications when this account receives Kaspa.";
}

/// Why a regular address's Hide refuses (K b49a021d hideAddress): an address holding Kaspa stays on
/// the list. Null when it may hide (a live zero-balance read still has the last word).
export function coldHideRefusal(balanceSompi) {
  return (Number(balanceSompi) || 0) > 0 ? "An address holding Kaspa stays on the list." : null;
}

/// Re-reading the stored accounts (audit 2026-11-27): the records already on screen are KEPT and
/// refreshed in place, matched by id, so an action holding one across an await (Discover, Generate,
/// a rename being typed, a confirm) still writes into the list that gets saved. New records come
/// in as given; records no longer stored drop out. Returns the stored order.
export function mergeColdAccountsById(live, stored) {
  const byId = new Map((live || []).filter((a) => a?.id).map((a) => [a.id, a]));
  return (stored || []).map((fresh) => {
    const kept = byId.get(fresh?.id);
    if (!kept || kept === fresh) return fresh;
    for (const key of Object.keys(kept)) if (!(key in fresh)) delete kept[key];
    return Object.assign(kept, fresh);
  });
}

/// An address holding Kaspa is never out of sight (audit 2026-11-27): hiding is a display
/// preference, never a way to lose sight of real funds. The hidden indexes whose known balance is
/// above zero, to un-hide. `entries` are `{ index, balanceSompi }`; an unknown balance never counts.
export function coldFundedHiddenIndexes(hidden, entries) {
  const hiddenSet = new Set((hidden || []).map(Number));
  const funded = new Set();
  for (const e of entries || []) {
    if (e && e.index !== null && e.index !== undefined && hiddenSet.has(Number(e.index)) && (Number(e.balanceSompi) || 0) > 0) funded.add(Number(e.index));
  }
  return [...funded].sort((a, b) => a - b);
}

/// The account screen's cards: the visible addresses, and any hidden one holding Kaspa.
export function coldShownEntries(entries, hidden) {
  const hiddenSet = new Set((hidden || []).map(Number));
  return (entries || []).filter((e) => !hiddenSet.has(Number(e.index)) || (Number(e.balanceSompi) || 0) > 0);
}

/// The Total Balance: every funded address of the account, hidden or not.
export function coldTotalSompi(entries) {
  return (entries || []).reduce((sum, e) => sum + (Number(e?.balanceSompi) || 0), 0);
}

/// Which Cold Storage screen is up: "address", "visibility", "detail" (the open account) or
/// "list". A late price repaints only the screen it was drawn for (audit 2026-11-27).
export function coldScreenName({ activeAccountId, activeAddressIndex, showingVisibility }) {
  if (activeAccountId && activeAddressIndex !== null && activeAddressIndex !== undefined) return "address";
  if (activeAccountId && showingVisibility) return "visibility";
  if (activeAccountId) return "detail";
  return "list";
}

/// The kpub's 30-second clear (audit 2026-11-27): only while the clipboard still holds that kpub.
/// Anything copied since stays; a clipboard that can't be read (`current` null / undefined) is
/// left alone rather than wiped.
export function coldClipboardStillHolds(current, copied) {
  if (typeof current !== "string" || typeof copied !== "string" || !copied) return false;
  return current.trim() === copied.trim();
}

/// Which zero-balance addresses get their Used answer again after an account's balances are read
/// (K 01f71184, release audit C1 / smoothness L1). The earlier answers carry over, so a used-but-empty
/// address never drops into Unused while the list reloads; but an address whose balance moved since
/// (a send's change landed and left again) or whose last check failed is asked again, so it doesn't
/// stay Unused until a refresh. One that held Kaspa before was used (`heldBefore`, no request).
/// `entries` are `{ address, balanceSompi, everUsed }` with the fresh balances; `balanceBefore` maps
/// address -> the balance shown before the read (undefined when none was).
export function coldUsedRecheck(entries, balanceBefore) {
  const heldBefore = [];
  const toProbe = [];
  for (const entry of entries || []) {
    if (!entry || entry.everUsed === true || (Number(entry.balanceSompi) || 0) > 0) continue;
    const before = balanceBefore?.get?.(entry.address);
    if ((Number(before) || 0) > 0) { heldBefore.push(entry); continue; }
    if (entry.everUsed === undefined || entry.everUsed === null || before !== entry.balanceSompi) toProbe.push(entry);
  }
  return { heldBefore, toProbe };
}

/// Coin activity reloads an open account once, a second after the last notice, and never cancels a
/// load in progress: activity during one queues a single reload after it (K 01f71184 C4 / L4, as
/// ColdStorageDetailView.reloadAfterActivity). `load()` returns a Promise; `timers` is
/// `{ setTimeout, clearTimeout }`. Returns `request()`.
export function coldActivityReloader(load, { delayMs = 1000, timers = globalThis } = {}) {
  let timer = null;
  let running = false;
  let queued = false;
  function request() {
    if (running) { queued = true; return; }
    if (timer !== null) timers.clearTimeout(timer);
    timer = timers.setTimeout(async () => {
      timer = null;
      running = true;
      try { await load(); } catch { /* the next notice tries again */ }
      running = false;
      if (queued) { queued = false; request(); }
    }, delayMs);
  }
  return request;
}
