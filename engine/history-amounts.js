// An address history row's amount when a transaction also spent coins that aren't this wallet's
// (K 961fc05a KaspaFullTransactionResponse.ownHistoryAmount, swap history amounts). A kUSDT swap
// spends Trestly's pool, which pays its whole balance back to itself, and that output counted as
// "Sent" (-367,808 KAS for a swap of a few KAS, owner 2026-11-25). Pure, for
// tools/test-swap-history-amounts.mjs.

const lower = (value) => String(value || "").trim().toLowerCase();
const big = (value) => { try { return BigInt(value ?? 0); } catch { return 0n; } };
function inputAddress(input) {
  return lower(input?.previous_outpoint_address || input?.previousOutpointAddress
    || input?.previous_outpoint_resolved?.script_public_key_address || "");
}
function inputAmount(input) {
  const raw = input?.previous_outpoint_amount ?? input?.previousOutpointAmount ?? input?.previous_outpoint_resolved?.amount;
  return raw == null || raw === "" ? null : big(raw);
}

/**
 * Works from what left this wallet instead of what went to "others": its inputs, less what came back
 * to it (this address, and `ownChange`, the change to this wallet's other addresses) and its part of
 * the network fee, never more than went to others (`toOthers`). When the wallet came out ahead (a
 * swap that paid it Kaspa) the row is Received, by that much. Null when an input of this wallet has
 * no known amount (or this address paid nothing in), so the caller keeps its own figure.
 *
 * The wallet, not this address alone (audit 2026-11-25 L2): when two of this wallet's addresses fund
 * one send, nothing says which paid what, so each funding address's row shows the same
 * whole-transaction figure. `isOwnAddress(lowercased)` says which other input addresses are this
 * wallet's.
 *
 * The fee: with only this wallet's coins in, it paid all of it. With another party's coins in too (a
 * swap pool), its share by amount (its inputs over all inputs); with an outside input of unknown
 * amount the share can't be worked out, so no fee is taken off.
 *
 * Returns `{ isOutgoing, amountSompi }` (BigInt) or null.
 */
export function ownHistoryAmount(tx, address, { toOthers = 0n, ownChange = 0n, isOwnAddress = () => false } = {}) {
  const self = lower(address);
  if (!self) return null;
  let spentHere = 0n;
  let spentByWallet = 0n;
  let inputTotal = 0n;
  let allInputsKnown = true;
  let outsideInputs = false;
  for (const input of Array.isArray(tx?.inputs) ? tx.inputs : []) {
    const from = inputAddress(input);
    const here = from === self;
    let ours = here;
    if (!ours && from) { try { ours = Boolean(isOwnAddress(from)); } catch { ours = false; } }
    if (!ours) outsideInputs = true;
    const amount = inputAmount(input);
    if (amount == null) {
      if (ours) return null;
      allInputsKnown = false;
      continue;
    }
    inputTotal += amount;
    if (here) spentHere += amount;
    if (ours) spentByWallet += amount;
  }
  if (spentHere <= 0n) return null;
  const outputs = Array.isArray(tx?.outputs) ? tx.outputs : [];
  const outputTotal = outputs.reduce((sum, output) => sum + big(output?.amount), 0n);
  const returnedHere = outputs
    .filter((output) => lower(output?.script_public_key_address || output?.scriptPublicKeyAddress) === self)
    .reduce((sum, output) => sum + big(output?.amount), 0n);
  const returnedToWallet = returnedHere + big(ownChange);
  if (returnedToWallet >= spentByWallet) {
    // came out ahead (or even): what it gained
    return returnedToWallet > spentByWallet ? { isOutgoing: false, amountSompi: returnedToWallet - spentByWallet } : null;
  }
  let paid = spentByWallet - returnedToWallet;
  const fee = allInputsKnown && inputTotal >= outputTotal ? inputTotal - outputTotal : 0n;
  const walletFee = !outsideInputs || inputTotal === 0n ? fee : (fee * spentByWallet) / inputTotal;
  paid -= paid < walletFee ? paid : walletFee;
  const others = big(toOthers);
  return { isOutgoing: true, amountSompi: paid < others ? paid : others };
}
