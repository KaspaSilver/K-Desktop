// node tools/test-key-vault-carry.mjs - audit 2026-11-25:
//   #14 a chatting-address switch carries the account's password, Face ID and Nextcloud connection
//       to the new address (ui/key-vault.js beginAccountVaultCarry / finishAccountVaultCarry /
//       abandonAccountVaultCarry), instead of forcing "Set a Password" and leaving the old vault
//       behind for a switch back to demand the old password.
//   #29 wrong passwords are counted per vault: one account's lockout no longer locks the others,
//       and the device-wide counter of earlier builds carries over to every vault.
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const kv = await import("../ui/key-vault.js");

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
  get length() { return this.map.size; }
  key(index) { return [...this.map.keys()][index] ?? null; }
  dump() { return [...this.map.entries()].map(([k, v]) => `${k}=${v}`).join("\n"); }
}

const A = "kaspa:qpaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "kaspa:qpbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const KEY_A = "1a".repeat(32);
const KEY_B = "2b".repeat(32);
const WORDS = "abandon ability able about above absent absorb abstract absurd abuse access accident";
const NC_PASSWORD = "nc-app-password-XYZ-12345";
const ncKey = (address) => `kachat-account-data-v1:${address}:${kv.NEXTCLOUD_STORAGE_KEY}`;
const entry = (address, privateKeyHex) => ({ version: 1, address, privateKeyHex, mnemonic: WORDS, passphrase: "", name: "Mine", chattingIndex: address === A ? 0 : 1 });
const PRF = new Uint8Array(32).fill(7);

let local;
let target = "";
function fresh() {
  local = new MemoryStorage();
  kv.lockKeyVault();
  kv.configureKeyVault({ storage: local, session: new MemoryStorage(), iterations: 1000, canonicalize: (a) => String(a || "").trim().toLowerCase(), target: () => target });
}
const passwordMap = () => JSON.parse(local.getItem(kv.ACCOUNT_PASSWORDS_KEY) || "{}");
const biometricMap = () => JSON.parse(local.getItem(kv.ACCOUNT_BIOMETRIC_KEY) || "{}");
const byAddress = (address) => kv.readAccountRecords().find((e) => e.address === address);
function assertNoPlaintext() {
  const dump = local.dump();
  for (const secret of [KEY_A, KEY_B, WORDS, NC_PASSWORD]) assert.ok(!dump.includes(secret), `no plaintext ${secret.slice(0, 12)} at rest`);
}
/** A with its own password, Face ID and a Nextcloud connection, signed in. */
async function ownVaultA() {
  target = A;
  kv.writeAccountRecords([entry(A, KEY_A)]);
  await kv.setAppPassword("password-A1", A);
  await kv.enrolBiometricUnlock({ credentialId: "cred-1", salt: "00".repeat(32), prfOutput: PRF, address: A });
  kv.writeNextcloudAccount(ncKey(A), { server: "https://cloud.example.org", username: "me", appPassword: NC_PASSWORD });
  assertNoPlaintext();
}
/** What performChattingAddressSwitch does between begin and finish: B saved, A's entry dropped. */
function saveSwitch(from, to, toKey) {
  target = to;
  kv.writeAccountRecords([...kv.readAccountRecords(), entry(to, toKey)]);
  kv.writeAccountRecords(kv.readAccountRecords().filter((e) => e.address !== from));
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("#14 own password: the switch carries the password, Face ID and Nextcloud; the old vault goes", async () => {
  fresh();
  await ownVaultA();
  assert.equal(kv.beginAccountVaultCarry(A, B), true);
  target = B;
  assert.equal(kv.hasAppPassword(B), true, "no forced Set a Password");
  assert.equal(kv.isAppLocked(B), false);
  assert.equal(kv.hasBiometricUnlock(B), true, "Face ID carried");
  assert.equal(kv.readNextcloudAccount(ncKey(B))?.appPassword, NC_PASSWORD, "Nextcloud carried, sealed for B");
  // A untouched until the switch has landed.
  assert.ok(passwordMap()[A] && biometricMap()[A] && local.getItem(ncKey(A)));
  saveSwitch(A, B, KEY_B);
  assert.equal(kv.finishAccountVaultCarry(A, B), true);
  assert.deepEqual(Object.keys(passwordMap()), [B], "A's vault released");
  assert.deepEqual(Object.keys(biometricMap()), [B], "A's Face ID record released");
  assert.equal(local.getItem(ncKey(A)), null, "A's Nextcloud copy removed");
  assertNoPlaintext();
  // A new page: the same password opens B, and so does Face ID.
  kv.lockKeyVault();
  assert.equal(kv.isAppLocked(B), true);
  assert.equal(await kv.unlockKeyVault("password-A1", B), true);
  assert.equal(byAddress(B).privateKeyHex, KEY_B);
  assert.equal(kv.readNextcloudAccount(ncKey(B))?.appPassword, NC_PASSWORD);
  kv.lockKeyVault();
  assert.deepEqual(await kv.unlockKeyVaultWithBiometric(PRF, B), { ok: true });
});

test("#14 switching back carries the same password again (no old password asked)", async () => {
  fresh();
  await ownVaultA();
  kv.beginAccountVaultCarry(A, B);
  saveSwitch(A, B, KEY_B);
  kv.finishAccountVaultCarry(A, B);
  assert.equal(kv.beginAccountVaultCarry(B, A), true);
  saveSwitch(B, A, KEY_A);
  kv.finishAccountVaultCarry(B, A);
  assert.deepEqual(Object.keys(passwordMap()), [A]);
  kv.lockKeyVault();
  target = A;
  assert.equal(await kv.unlockKeyVault("password-A1", A), true);
  assert.equal(byAddress(A).privateKeyHex, KEY_A);
  assertNoPlaintext();
});

test("#14 shared password: the new address joins the shared vault", async () => {
  fresh();
  target = "";
  kv.writeAccountRecords([entry(A, KEY_A)]);
  await kv.setAppPassword("shared-password"); // no account in question: the shared vault
  kv.writeNextcloudAccount(ncKey(A), { server: "https://cloud.example.org", username: "me", appPassword: NC_PASSWORD });
  target = A;
  assert.equal(kv.hasAppPassword(A), true);
  assert.equal(kv.beginAccountVaultCarry(A, B), true);
  target = B;
  assert.equal(kv.hasAppPassword(B), true, "no forced Set a Password");
  assert.equal(kv.isAppLocked(B), false);
  saveSwitch(A, B, KEY_B);
  kv.finishAccountVaultCarry(A, B);
  assert.equal(local.getItem(kv.ACCOUNT_PASSWORDS_KEY), null, "no vault of its own was made");
  assert.ok(local.getItem(kv.APP_PASSWORD_KEY), "the shared password stays (B is in it)");
  assert.equal(kv.releaseAppPasswordIfUnused(), false);
  assert.equal(local.getItem(ncKey(A)), null);
  assertNoPlaintext();
  kv.lockKeyVault();
  assert.equal(kv.hasAppPassword(B), true, "B is a saved member of the shared vault now");
  assert.equal(await kv.unlockKeyVault("shared-password", B), true);
  assert.equal(byAddress(B).privateKeyHex, KEY_B);
  assert.equal(kv.readNextcloudAccount(ncKey(B))?.appPassword, NC_PASSWORD);
});

test("#14 a failed switch: abandon leaves A exactly as it was and drops B's copies", async () => {
  fresh();
  await ownVaultA();
  const before = local.dump();
  kv.beginAccountVaultCarry(A, B);
  assert.equal(kv.abandonAccountVaultCarry(A, B), true);
  assert.equal(local.dump(), before, "storage back to what it was");
  assert.equal(kv.isVaultUnlocked(A), true, "A stays open");
  target = B;
  assert.equal(kv.hasAppPassword(B), false);
  kv.lockKeyVault();
  assert.equal(await kv.unlockKeyVault("password-A1", A), true);
  assert.equal(byAddress(A).privateKeyHex, KEY_A);
});

test("#14 locked: nothing is carried or written", async () => {
  fresh();
  await ownVaultA();
  kv.lockKeyVault();
  const before = local.dump();
  assert.throws(() => kv.beginAccountVaultCarry(A, B), /locked/i);
  assert.equal(local.dump(), before);
});

test("#14 a new address that is a saved account of its own keeps its own password", async () => {
  fresh();
  await ownVaultA();
  target = B;
  kv.writeAccountRecords([...kv.readAccountRecords(), entry(B, KEY_B)]); // plaintext until its password
  await kv.setAppPassword("password-B9", B);
  const recordB = JSON.stringify(passwordMap()[B]);
  target = A;
  assert.equal(kv.beginAccountVaultCarry(A, B), false);
  assert.equal(JSON.stringify(passwordMap()[B]), recordB);
});

test("#14 a vault left at the new address by an earlier switch is replaced, never reused", async () => {
  fresh();
  await ownVaultA();
  // An orphan vault at B (the old bug: switched to B, set another password, switched away).
  const raw = passwordMap();
  raw[B] = { record: { ...raw[A].record, salt: "ff".repeat(16) } };
  local.setItem(kv.ACCOUNT_PASSWORDS_KEY, JSON.stringify(raw));
  assert.equal(kv.beginAccountVaultCarry(A, B), true);
  assert.equal(JSON.stringify(passwordMap()[B].record), JSON.stringify(passwordMap()[A].record));
  saveSwitch(A, B, KEY_B);
  kv.finishAccountVaultCarry(A, B);
  kv.lockKeyVault();
  assert.equal(await kv.unlockKeyVault("password-A1", B), true);
});

test("#29 one account's wrong passwords don't lock out another", async () => {
  fresh();
  target = A;
  kv.writeAccountRecords([entry(A, KEY_A), entry(B, KEY_B)]);
  await kv.setAppPassword("password-A1", A);
  target = B;
  await kv.setAppPassword("password-B2", B);
  kv.lockKeyVault();
  for (let i = 0; i < 5; i += 1) assert.equal(await kv.unlockKeyVault(`wrong ${i}`, A), false);
  assert.ok(kv.appPasswordLockoutRemainingSeconds(A) >= 29, "A is locked out");
  assert.equal(await kv.unlockKeyVault("password-A1", A), false, "even with the right password");
  assert.equal(kv.appPasswordLockoutRemainingSeconds(B), null, "B is not");
  assert.equal(kv.appPasswordLockoutMessage(B), null);
  assert.equal(await kv.unlockKeyVault("password-B2", B), true);
  assert.ok(kv.appPasswordLockoutRemainingSeconds(A) >= 29, "B's success leaves A's lockout running");
  target = A;
  assert.match(kv.appPasswordLockoutMessage(), /Too many wrong passwords/, "the address-less call is the target's");
});

test("#29 the old device-wide lockout carries over to every vault, then goes", async () => {
  fresh();
  target = A;
  kv.writeAccountRecords([entry(A, KEY_A), entry(B, KEY_B)]);
  await kv.setAppPassword("password-A1", A);
  target = B;
  await kv.setAppPassword("password-B2", B);
  kv.lockKeyVault();
  local.setItem("kachat-app-password-failed-attempts", "6");
  local.setItem("kachat-app-password-locked-until", String(Date.now() / 1000 + 120));
  assert.ok(kv.appPasswordLockoutRemainingSeconds(A) > 100);
  assert.ok(kv.appPasswordLockoutRemainingSeconds(B) > 100);
  assert.equal(local.getItem("kachat-app-password-failed-attempts"), null);
  assert.equal(local.getItem("kachat-app-password-locked-until"), null);
  assert.equal(await kv.unlockKeyVault("password-B2", B), false, "still locked out");
  // Once it runs out, the next miss escalates from the carried count (6 -> 7: 120 s).
  const map = JSON.parse(local.getItem(kv.LOCKOUT_ATTEMPTS_KEY));
  map[B].lockedUntil = 0;
  local.setItem(kv.LOCKOUT_ATTEMPTS_KEY, JSON.stringify(map));
  assert.equal(await kv.unlockKeyVault("wrong", B), false);
  assert.ok(kv.appPasswordLockoutRemainingSeconds(B) > 100);
});

test("#29 a released vault's counter goes with it", async () => {
  fresh();
  target = A;
  kv.writeAccountRecords([entry(A, KEY_A)]);
  await kv.setAppPassword("password-A1", A);
  kv.lockKeyVault();
  await kv.unlockKeyVault("wrong", A);
  assert.ok(JSON.parse(local.getItem(kv.LOCKOUT_ATTEMPTS_KEY))[A]);
  kv.writeAccountRecords([]);
  target = "";
  assert.equal(kv.releaseAppPasswordIfUnused(), true);
  assert.equal(local.getItem(kv.LOCKOUT_ATTEMPTS_KEY), null);
});

let passed = 0;
for (const [name, fn] of tests) {
  try { await fn(); passed += 1; console.log(`ok   ${name}`); }
  catch (error) { console.error(`FAIL ${name}`); throw error; }
}
console.log(`\nall ${passed} passed`);
