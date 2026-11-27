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
