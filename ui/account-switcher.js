// The Profile tab's account switcher (K 8cb4c88e AccountSwitcher.swift): the pieces that need no
// page. app.js draws the chip beside Profile's title and the Accounts sheet, and switches with the
// sign-in screen's own steps.

/** The chip's words (iOS ProfileAccountChip.label): your username, a long one cut in the middle so
 *  the chip stays beside the title, else your address short ("qzvr…l9ug"). */
export function accountChipLabel({ username = "", address = "" } = {}) {
  const name = String(username || "").trim();
  if (name) return name.length > 18 ? `${name.slice(0, 9)}…${name.slice(-7)}` : name;
  const full = String(address || "").trim();
  if (!full) return "";
  const at = full.indexOf(":");
  const body = at >= 0 ? full.slice(at + 1) : full;
  return body.length > 10 ? `${body.slice(0, 4)}…${body.slice(-4)}` : body;
}

/** The sheet's order (iOS AccountSwitcherSheet.accounts): the signed-in account first, then the
 *  rest as the sign-in screen lists them. */
export function switcherAccounts(accounts, isCurrent) {
  const all = Array.isArray(accounts) ? accounts.filter(Boolean) : [];
  return [...all.filter((account) => isCurrent(account)), ...all.filter((account) => !isCurrent(account))];
}

/** Whether this device holds `account`'s keys (iOS WalletManager.hasKeysOnThisPhone): in the clear,
 *  or sealed under a password. Without them signing in needs its recovery phrase. */
export function hasKeysOnThisDevice(account) {
  if (!account || typeof account !== "object") return false;
  return Boolean(String(account.privateKeyHex || "").trim() || account.sealed);
}
