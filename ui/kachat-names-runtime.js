// The one shared .kachat names runtime (iOS KachatNamesService.shared / KachatNamesRegistry.shared /
// KachatNamesActions.shared): a single service, registry and actions instance for the whole app,
// so the Hub screens, name resolution, Your Domains and the profile hero all read the same registry
// and see the same registrations in flight.
//
// Two gates (iOS 7227d69, KachatNamesService.isEnabled / isLaunched):
//  - `kachatNamesUiEnabled()`: the .kachat UI and identity - true on every network: people by
//    assigned name, else .kachat name, else short address - never by KNS.
//  - `kachatNamesLaunched()`: a live registry here - testnet-10, and mainnet since its launch on
//    2026-10-09 (KachatNamesService.isLaunched, iOS ef6b21e). `kachatNames()` is the registry
//    runtime and exists only then; where it is null nothing reads or writes a registry: refresh,
//    owner tags, registration resume and typed-name resolution all need it.
//  - `kachatProfilesEnabled()`: address profiles (iOS d36fc42) - every network. A profile is a
//    `kchat:1:profile:` self-send, not registry data, so `kachatProfiles()` exists where the
//    registry isn't launched too: the same `{ engine, service, registry, actions }` shape, with an
//    inert registry (isEnabled false: prepare/reads refuse, refreshes are no-ops) where only the
//    profile side runs - `registry.identity(address)` (profile-only: own saved record, else
//    GET /profiles/{address} on the chat indexer), `registry.ownProfile` / `noteOwnProfile`,
//    `actions.profileSigner` / `profileFee` / `saveProfile`. Where the registry is launched
//    `kachatProfiles()` is the registry runtime itself.
import { getEndpoint } from "../engine/endpoints.js";
import { KachatNamesService } from "../engine/kachat-names/service.js";
import { KachatNamesRegistry, addressOf as registryAddressOf } from "../engine/kachat-names/registry.js";
import { KachatNamesActions } from "../engine/kachat-names/actions.js";

let runtime = null;
/** the profile-only runtime where the registry isn't launched (mainnet) */
let profilesRuntime = null;

const localStorageAdapter = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* storage full: next refresh re-walks */ } },
};

/** Whether the .kachat UI and identity apply here: every network (iOS isEnabled, 7227d69). */
export function kachatNamesUiEnabled() { return KachatNamesService.isEnabled; }

/** Whether this network has a live .kachat registry (testnet-10 and mainnet; iOS isLaunched, ef6b21e). */
export function kachatNamesLaunched() { return KachatNamesService.isLaunched; }

/** Whether address profiles (save your own, read others') work here: every network (iOS
 *  profilesEnabled, d36fc42). */
export function kachatProfilesEnabled() { return KachatNamesService.profilesEnabled; }

/**
 * Builds the runtime once the engine exists, where the registry is launched. Safe to call more
 * than once. `wallet` (optional): the wallet's other addresses for owner actions on names they hold
 * (iOS 881ada6) - `{ spendingAddresses() -> [{ index, address }], spendingPrivateKey(index) -> hex|null,
 * kasSignerAddresses() -> [{ account, index, address }] }`; see engine/kachat-names/actions.js.
 * `onSubmitted(txId)` (optional): called for every registry transaction the service submits and the
 * node accepts (iOS 32fdaa4: the app suppresses it as a payment the moment it is sent).
 */
export function initKachatNamesRuntime(engine, { wallet = null, onSubmitted = null } = {}) {
  if (!engine) return runtime;
  if (!kachatNamesLaunched()) {
    initProfilesOnly(engine);
    return runtime;
  }
  if (runtime) return runtime;
  const service = new KachatNamesService(engine);
  if (typeof onSubmitted === "function") service.onSubmitted(onSubmitted);
  const registry = new KachatNamesRegistry({
    manifest: () => service.loadManifest(),
    isEnabled: () => KachatNamesService.isLaunched,
    getUtxosByAddresses: (addresses) => engine.utxosForRegistry(addresses),
    restBase: () => getEndpoint("kaspaApi"),
    // Connection Settings > Domains' own field, apart from the message indexer (iOS 7abc06e8).
    indexerBase: () => getEndpoint("kachatNamesIndexer"),
    // An indexer more than ~1 minute behind the network is skipped (iOS 7aa6c6d).
    virtualDaaScore: async () => (await engine.currentDagPoint()).virtualDaaScore,
    // the walker's cache is per network (registryCacheKeyFor the manifest's network, iOS ef6b21e)
    storage: localStorageAdapter,
  });
  const actions = new KachatNamesActions({ engine, service, registry, wallet });
  // Name lookups and account discovery read the same registry (iOS 25cc2c9): a typed alice or
  // alice.kachat resolves to the owner of a name that is active or in grace - only a lapsed name
  // stops resolving (iOS f7c371a) - refreshed when older than a minute.
  engine.setKachatNameHooks?.({
    resolve: async (canonical) => {
      await registry.refreshIfStale();
      return registry.resolveHeldOnChain(canonical, service);
    },
    ownsAny: async (address) => {
      const key = KachatNamesRegistry.keyOf(address);
      if (!key) return false;
      await registry.refreshIfStale();
      return (await registry.namesOf(key, { includeInactive: true })).length > 0;
    },
    // The names an address holds (active or in grace), for the chatting-address scan (iOS 6ac48a7).
    held: async (address) => {
      const key = KachatNamesRegistry.keyOf(address);
      if (!key) return [];
      await registry.refreshIfStale();
      return (await registry.heldNames(key)).map((n) => n.name);
    },
  });
  runtime = { engine, service, registry, actions };
  return runtime;
}

/** No registry on this network: the service, an inert registry (no manifest, isEnabled false - it never reads or writes
 *  registry data, only profiles) and the actions for the profile record. No name hooks: typed
 *  names don't resolve where there is no registry. */
function initProfilesOnly(engine) {
  if (profilesRuntime || !kachatProfilesEnabled()) return profilesRuntime;
  const service = new KachatNamesService(engine);
  const registry = new KachatNamesRegistry({
    manifest: null,
    isEnabled: () => false,
    getUtxosByAddresses: null,
    restBase: () => "",
    indexerBase: () => getEndpoint("kachatNamesIndexer"),
    storage: localStorageAdapter,
  });
  const actions = new KachatNamesActions({ engine, service, registry });
  profilesRuntime = { engine, service, registry, actions };
  return profilesRuntime;
}

/** The shared registry runtime, or null where the registry is not launched or before init. */
export function kachatNames() { return runtime; }

// --- .kachat names on payment screens, confirmed on the chain (KaPost iOS f954738 verifyLabel) ---
// A payment card names an address by its .kachat label only once the chain backs it: the label the
// identity gives, looked up as a registered name of that same owner, not lapsed, and the record held
// by a node (confirmOnChain). The indexer's word alone never names who you pay. Kept ten minutes; one
// check per address at a time; a check that couldn't finish isn't kept.
const VERIFIED_LABEL_MAX_AGE_MS = 600_000;
const verifiedLabels = new Map();
const labelChecks = new Map();
const labelCheckFailedAt = new Map();
/** The address's confirmed label (in the last ten minutes), else null. Never starts a check. */
export function kachatVerifiedLabel(address) {
  const entry = verifiedLabels.get(String(address || "").trim().toLowerCase());
  return entry && Date.now() - entry.at < VERIFIED_LABEL_MAX_AGE_MS ? entry.label : null;
}
/** Whether a check for the address is running now. */
export function kachatLabelChecking(address) {
  return labelChecks.has(String(address || "").trim().toLowerCase());
}
/** Confirms the address's label on the chain: the label, or null (no name, or none confirmed). */
export function verifyKachatLabel(address) {
  const key = String(address || "").trim().toLowerCase();
  if (!runtime || !KachatNamesService.isLaunched || !KachatNamesService.profilesEnabled || !KachatNamesRegistry.keyOf(key)) return Promise.resolve(null);
  const cached = verifiedLabels.get(key);
  if (cached && Date.now() - cached.at < VERIFIED_LABEL_MAX_AGE_MS) return Promise.resolve(cached.label);
  if (labelChecks.has(key)) return labelChecks.get(key);
  // one that couldn't be checked is asked again after a minute, not on every redraw
  if (Date.now() - (labelCheckFailedAt.get(key) || 0) < 60_000) return Promise.resolve(null);
  const { registry, service } = runtime;
  const check = (async () => {
    let identity;
    try { identity = await registry.identity(key); } catch { return undefined; }
    const candidate = identity?.label;
    if (!candidate) return null;
    try {
      const found = await registry.lookup(candidate);
      const n = found?.kind === "registered" ? found.info : null;
      if (!n || n.name !== candidate) return null;
      if (String(KachatNamesRegistry.addressOf?.(n.owner) ?? registryAddressOf(n.owner) ?? "").toLowerCase() !== key) return null;
      if (n.status(registry.graceMs, Date.now()) === "lapsed") return null;
      await registry.confirmOnChain(n, service);
      return candidate;
    } catch { return undefined; }
  })().then((answer) => {
    labelChecks.delete(key);
    if (answer === undefined) { labelCheckFailedAt.set(key, Date.now()); return null; } // couldn't be checked: not kept
    verifiedLabels.set(key, { label: answer, at: Date.now() });
    return answer;
  });
  labelChecks.set(key, check);
  return check;
}

/** The runtime for address profiles on every network (`{ engine, service, registry, actions }`):
 *  the registry runtime where it is launched, else the profile-only one (inert registry). Null
 *  before init. Use only the profile side of it: registry.identity / ownProfile / noteOwnProfile /
 *  onChange / revision and actions.profileSigner / profileFee / saveProfile / myAddress. */
export function kachatProfiles() { return runtime ?? profilesRuntime; }
