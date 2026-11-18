// Addresses in log lines (iOS d23e6f7a AppLog.shortenAddresses, KaPay 1652437): every full Kaspa
// address in a line is cut to "…" and its last 8 characters, wherever it came from (a message, a
// URL, a storage key name), so no caller has to remember. The diagnostics export carries the log,
// and the person sharing it shouldn't be handing out every address they and their contacts use.

// `kaspa:`, `kaspatest:` (and the sim/dev prefixes), or the `_` form used in keys and file names.
// Not `\b` at the start (KaPlay 077d777): "_" is a word character, so an address right after one
// (`wallet_kaspa:qr...`) wasn't shortened.
const ADDRESS_PATTERN = /(?<![a-z0-9])(?:kaspa|kaspatest|kaspasim|kaspadev)[:_]([a-z0-9]{12,})/gi;

/** `line` with every full address shortened to "…" + its last 8 characters. */
export function shortenLogAddresses(line) {
  return String(line ?? "").replace(ADDRESS_PATTERN, (_match, payload) => `…${payload.slice(-8)}`);
}

/** A transaction id in a log line (a whole 64-hex run, on its own or inside a URL) is cut to its
 *  first 12 characters (KaPost b78fdb0: logs shorten tx ids) - enough to tell sends apart. */
const TXID_PATTERN = /(?<![0-9a-fA-F])([0-9a-fA-F]{12})[0-9a-fA-F]{52}(?![0-9a-fA-F])/g;
export function shortenLogTxIds(line) {
  return String(line ?? "").replace(TXID_PATTERN, (_match, head) => `${head}…`);
}
