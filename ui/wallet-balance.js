// The Wallet tab's numbers (iOS bfe9f022 WalletView), without a DOM, for
// tools/test-wallet-balance.mjs. Amounts are BigInt sompi, null while unknown. Unknown is never 0:
// a read that failed shows as a dash, not as an empty wallet.

/** Both parts or nothing: a total missing one of them would read as the whole balance. */
export function walletTotalSompi(chattingSompi, spendingSompi) {
  if (chattingSompi == null || spendingSompi == null) return null;
  return BigInt(chattingSompi) + BigInt(spendingSompi);
}

/**
 * The spending total after a read. `readSompi` is null when the read failed, and that leaves the
 * previous total in place: a few seconds stale reads better than a figure that vanishes because
 * one request timed out.
 */
export function spendingTotalAfterRead(previousSompi, readSompi) {
  return readSompi ?? previousSompi ?? null;
}

/** One batched read's per-address balances added up (Numbers from the node's answer). */
export function sumBalancesSompi(balances) {
  let sompi = 0n;
  for (const value of balances) sompi += BigInt(Math.round(Number(value) || 0));
  return sompi;
}

/** `format` for a known amount, the dash for an unknown one. */
export function walletAmountText(sompi, format) {
  return sompi == null ? "--" : format(sompi);
}

/** A fiat figure to the cent ("$0.14", "$1,234.50"; 8 places for bitcoin), as K's Wallet card and
 *  address cards show it (K 01f71184 formatFiatAmount's default: the Wallet card had "$0.1399"
 *  beside "$0.14" on Manage Addresses). "" for a value that isn't a number. */
export function fiatFixedText(value, symbol, { decimals = 2, locale = undefined } = {}) {
  const v = Number(value);
  if (!Number.isFinite(v)) return "";
  const text = Math.abs(v).toLocaleString(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return `${v < 0 && text.replace(/[^1-9]/g, "") ? "-" : ""}${symbol}${text}`;
}

/** An address card's balance (K 01f71184 ManagedAddressCardAmount): all eight decimals, but an
 *  empty address reads "0 KAS", not "0.00000000 KAS"; "-- KAS" while it isn't known. `kas` is a
 *  KAS number or text. */
export function addressCardKasText(kas, unit = "KAS") {
  if (kas === null || kas === undefined || kas === "") return `-- ${unit}`;
  const n = Number(kas);
  if (!Number.isFinite(n)) return `-- ${unit}`;
  return `${n === 0 ? "0" : n.toFixed(8)} ${unit}`;
}
