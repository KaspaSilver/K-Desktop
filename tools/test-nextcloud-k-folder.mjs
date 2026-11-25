// node tools/test-nextcloud-k-folder.mjs - the Nextcloud folder is "K" (K 961fc05a, owner 2026-11-25;
// NextcloudService.backupFolderName, media in K/Media). An account with the old "KaChat" folder has
// it moved to "K" the first time the app touches Nextcloud (migrateLegacyFolderIfNeeded: one WebDAV
// MOVE; a folder the user picked stays), once per account as one shared run, checked again weekly;
// when both folders hold kachat-contacts.json the old one is merged in (mergeLegacyContactsFile);
// discovery takes a bare "K" or "KaChat" folder only at the root.
//
// Runs the real ui/nextcloud.js (through Vite, for import.meta.env) against an in-memory WebDAV
// server that knows folders, so a MOVE of a folder takes everything in it along.
import assert from "node:assert/strict";
import { createServer } from "vite";
import { readFileSync } from "node:fs";

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
  get length() { return this.map.size; }
  key(index) { return [...this.map.keys()][index] ?? null; }
}

const PREFIX = "kachat-account-data-v1";
const WALLET = "kaspa:qzwalletaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ALICE = "kaspa:qpalice00000000000000000000000000000000000000000000000000";
const BOB = "kaspa:qpbob0000000000000000000000000000000000000000000000000000";
const KEY_HEX = "11".repeat(32);
const SERVER = "https://cloud.example.test";

// --- The browser, as far as these modules look at it ---------------------------------------------
const local = new MemoryStorage();
const logs = [];
let nowOffset = 0;
const realNow = Date.now.bind(Date);
Date.now = () => realNow() + nowOffset;
function stubElement(extra = {}) {
  return {
    hidden: false, disabled: false, innerHTML: "", textContent: "", value: "", dataset: {}, style: {},
    isConnected: true, childElementCount: 0, classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, removeAttribute() {}, appendChild() {},
    querySelector: () => stubElement(), querySelectorAll: () => [], closest: () => null, focus() {}, ...extra,
  };
}
const settingsEl = stubElement({ querySelector: () => null });
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.localStorage = local;
Object.defineProperty(globalThis, "location", { value: { hostname: "localhost", search: "", hash: "", href: "http://localhost/" }, configurable: true });
globalThis.document = {
  visibilityState: "visible",
  body: stubElement(),
  createElement: () => stubElement(),
  querySelector: (selector) => (selector === "[data-nextcloud-settings]" ? settingsEl : null),
  querySelectorAll: () => [],
  addEventListener: () => {},
};

// --- The fake WebDAV server, with folders ---------------------------------------------------------
const dav = {
  files: new Map(),   // "<user>/<path>" -> body
  dirs: new Set(),    // "<user>/<path>"
  log: [],
  hook: null,         // async ({ method, path, destination }) => Response | undefined
  reset() { this.files.clear(); this.dirs.clear(); this.log = []; this.hook = null; },
  dir(user, path) { const parts = path.split("/"); for (let i = 1; i <= parts.length; i += 1) this.dirs.add(`${user}/${parts.slice(0, i).join("/")}`); },
  put(user, path, body) { const parent = path.split("/").slice(0, -1).join("/"); if (parent) this.dir(user, parent); this.files.set(`${user}/${path}`, body); },
  get(user, path) { return this.files.get(`${user}/${path}`); },
  moves() { return this.log.filter((r) => r.method === "MOVE" && !r.path.split("/").pop().startsWith(".kachat-contacts.json.upload-")); },
};
const parentOf = (key) => key.split("/").slice(0, -1).join("/");
const etagOf = (body) => `"etag-${String(body).length}"`;
// Depth-1 listings in a line format, and just enough of DOMParser to read them (a folder is a
// collection with its own name; the depth-0 ETag answer is read by nextcloud.js's regex fallback).
const listingOf = (user, folder) => {
  const base = folder ? `${user}/${folder}` : user;
  const rows = [];
  for (const key of dav.dirs) if (parentOf(key) === base) rows.push(`<response|${user}|${key.slice(user.length + 1)}|1|0>`);
  for (const [key, body] of dav.files) if (parentOf(key) === base) rows.push(`<response|${user}|${key.slice(user.length + 1)}|0|${String(body).length}>`);
  return rows.join("\n");
};
globalThis.DOMParser = class {
  parseFromString(text) {
    const rows = String(text).split("\n").filter((line) => line.startsWith("<response|")).map((line) => line.slice(10, -1).split("|"));
    const element = ([owner, path, isDir, size]) => ({
      getElementsByTagNameNS: (_ns, tag) => ({
        href: [{ textContent: `/remote.php/dav/files/${owner}/${path.split("/").map(encodeURIComponent).join("/")}${isDir === "1" ? "/" : ""}` }],
        collection: isDir === "1" ? [{}] : [],
        getcontenttype: isDir === "1" ? [] : [{ textContent: "application/json" }],
        getcontentlength: [{ textContent: size }],
        getlastmodified: [{ textContent: "Thu, 05 Nov 2026 10:00:00 GMT" }],
        displayname: [{ textContent: path.split("/").pop() }],
      }[tag] || []),
    });
    return { getElementsByTagNameNS: (_ns, tag) => (tag === "response" ? rows.map(element) : []) };
  }
};
globalThis.fetch = async (url, init = {}) => {
  const method = String(init.method || "GET").toUpperCase();
  // the share link for a media upload
  if (String(url).includes("/ocs/v2.php/apps/files_sharing/")) return new Response(JSON.stringify({ ocs: { data: { url: `${SERVER}/s/TOKEN` } } }), { status: 200 });
  const match = /nc-proxy\/[^/]+\/remote\.php\/dav\/files\/([^/]+)(?:\/(.*))?$/.exec(String(url));
  assert.ok(match, `the fake only speaks WebDAV: ${url}`);
  const user = decodeURIComponent(match[1]);
  const path = (match[2] || "").split("/").filter(Boolean).map(decodeURIComponent).join("/");
  const headers = new Headers(init.headers || {});
  const destinationHeader = headers.get("destination") || "";
  const destination = (/\/remote\.php\/dav\/files\/[^/]+\/(.*)$/.exec(destinationHeader)?.[1] || "").split("/").filter(Boolean).map(decodeURIComponent).join("/");
  dav.log.push({ method, user, path, destination, destinationHeader, overwrite: headers.get("overwrite"), depth: headers.get("depth") });
  const hooked = await dav.hook?.({ method, path, destination });
  if (hooked) return hooked;
  const key = path ? `${user}/${path}` : user;
  const parentExists = !parentOf(key) || parentOf(key) === user || dav.dirs.has(parentOf(key));
  switch (method) {
    case "GET":
      return dav.files.has(key) ? new Response(dav.files.get(key), { status: 200 }) : new Response("", { status: 404 });
    case "MKCOL":
      if (dav.dirs.has(key)) return new Response("", { status: 405 });
      if (!parentExists) return new Response("", { status: 409 });
      dav.dirs.add(key);
      return new Response(null, { status: 201 });
    case "PUT":
      if (!parentExists) return new Response("", { status: 409 });
      dav.files.set(key, typeof init.body === "string" ? init.body : await new Response(init.body).text());
      return new Response(null, { status: 201, headers: { "OC-ETag": etagOf(dav.files.get(key)) } });
    case "MOVE": {
      const target = `${user}/${destination}`;
      const exists = dav.files.has(target) || dav.dirs.has(target);
      if (exists && headers.get("overwrite") === "F") return new Response("", { status: 412 });
      if (dav.dirs.has(key)) {
        for (const dir of [...dav.dirs]) if (dir === key || dir.startsWith(`${key}/`)) { dav.dirs.delete(dir); dav.dirs.add(target + dir.slice(key.length)); }
        for (const [file, body] of [...dav.files]) if (file.startsWith(`${key}/`)) { dav.files.delete(file); dav.files.set(target + file.slice(key.length), body); }
        return new Response(null, { status: 201 });
      }
      if (!dav.files.has(key)) return new Response("", { status: 404 });
      dav.files.set(target, dav.files.get(key));
      dav.files.delete(key);
      return new Response(null, { status: 201, headers: { "OC-ETag": etagOf(dav.files.get(target)) } });
    }
    case "DELETE":
      return new Response(null, { status: dav.files.delete(key) ? 204 : 404 });
    case "PROPFIND":
      if (headers.get("depth") === "1") {
        if (path && !dav.dirs.has(key)) return new Response("", { status: 404 });
        return new Response(listingOf(user, path), { status: 207 });
      }
      if (!dav.files.has(key)) return new Response("", { status: 404 });
      return new Response(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:getetag>${etagOf(dav.files.get(key))}</d:getetag></d:multistatus>`, { status: 207 });
    default:
      return new Response("", { status: 405 });
  }
};

// --- The modules ----------------------------------------------------------------------------------
const vite = await createServer({
  configFile: false, root: process.cwd(), logLevel: "silent", appType: "custom",
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
});
const store = await vite.ssrLoadModule("/ui/address-book-store.js");
const nextcloud = await vite.ssrLoadModule("/ui/nextcloud.js");
const { sealBackupEnvelope, openBackupEnvelope } = await vite.ssrLoadModule("/ui/backup-crypto.js");
const { configureAddressBook, addressBookEntry, saveAddressBookEntry } = store;
const { initNextcloud, resetNextcloudForAccount, runBackup, migrateLegacyFolderIfNeeded, uploadNextcloudMedia } = nextcloud;

const scopedKey = (base, w = WALLET) => `${PREFIX}:${w}:${base}`;
const accountKey = () => scopedKey("kachat-nextcloud-v1");
const stored = () => JSON.parse(local.getItem(accountKey()) || "null");
let userSeq = 0;
let user = "sam";
/** A fresh account and server for each test: its own Nextcloud user, so nothing one test settled
 *  in this session's memory carries into the next. */
function fresh(fields = {}) {
  local.map.clear();
  dav.reset();
  logs.length = 0;
  nowOffset = 0;
  userSeq += 1;
  user = `sam${userSeq}`;
  configureAddressBook({
    storage: local,
    photoStorage: { get: () => null, set() {}, remove() {} },
    scopedKey,
    wallet: () => WALLET,
    isValidAddress: (a) => /^kaspa:[a-z0-9]{20,}$/.test(a),
    otherNetworkReason: () => null,
    now: () => Date.now(),
  });
  local.setItem(accountKey(), JSON.stringify({
    server: SERVER, username: user, userId: user, appPassword: "app-pass",
    startFolder: null, backupFolder: null, autoBackup: false, lastAutoBackup: Date.now(), backupFolderScanned: 3, ...fields,
  }));
}
let started = false;
function start() {
  if (started) { resetNextcloudForAccount(); return; }
  started = true;
  initNextcloud({
    accountScopedKey: (base, address = WALLET) => scopedKey(base, address),
    escapeHtml: (s) => String(s), appendEngineLog: (line) => logs.push(line), showToast() {},
    sealBackupPayload: async (json) => sealBackupEnvelope(json, KEY_HEX, WALLET),
    openBackupPayload: async (raw) => openBackupEnvelope(raw, KEY_HEX, WALLET),
    backupKeyAvailable: () => true,
    portfolioBackupSync: () => null,
    importPortfolioSync: () => false,
  });
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const contactsFile = (entries) => JSON.stringify({ type: "kachat-address-book", version: 1, exportedAt: "2026-11-05T10:00:00Z", walletAddress: WALLET, entries, deleted: [] });
const row = (address, name, updatedAt = "2026-11-01T10:00:00Z") => ({ id: "8F14E45F-CEEA-467F-A9B4-0C1D2E3F4A5B", address, name, note: "", createdAt: "2026-10-01T10:00:00Z", updatedAt });
const sealed = (entries) => sealBackupEnvelope(contactsFile(entries), KEY_HEX, WALLET);
const rootListings = () => dav.log.filter((r) => r.method === "PROPFIND" && r.depth === "1" && r.path === "").length;

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("the default folder is K, media goes to K/Media, and KaChat is only the old name", () => {
  const source = readFileSync(new URL("../ui/nextcloud.js", import.meta.url), "utf8");
  assert.match(source, /const DEFAULT_BACKUP_FOLDER = "K";/);
  assert.match(source, /const LEGACY_BACKUP_FOLDER = "KaChat";/);
  assert.match(source, /const MEDIA_FOLDER = `\$\{DEFAULT_BACKUP_FOLDER\}\/Media`;/);
  assert.doesNotMatch(source, /\["KaChat", "Media"\]|`KaChat\/Media\//, "no media path still names KaChat");
  for (const [file, line] of [["address-book.js", "Save it to the K folder in your Nextcloud"], ["portfolio.js", "Save the CSV to the K folder in your Nextcloud."]]) {
    assert.ok(readFileSync(new URL(`../ui/${file}`, import.meta.url), "utf8").includes(line), file);
  }
});

test("an account with only a root KaChat folder has it moved to K: one MOVE, everything along", async () => {
  fresh();
  dav.put(user, "KaChat/kachat-contacts.json", await sealed([row(ALICE, "Alice")]));
  dav.put(user, "KaChat/Media/abc_photo.jpg", "jpeg");
  dav.put(user, "KaChat/KaChat Contacts.json", "{}");
  start();
  await migrateLegacyFolderIfNeeded();
  const moves = dav.moves();
  assert.equal(moves.length, 1, "one MOVE");
  assert.equal(moves[0].path, "KaChat");
  assert.equal(moves[0].destination, "K");
  assert.equal(moves[0].overwrite, "F", "never over an existing K");
  assert.equal(moves[0].destinationHeader, `${SERVER}/remote.php/dav/files/${user}/K`, "the real server's own URL, never the relay's");
  assert.ok(dav.get(user, "K/kachat-contacts.json"), "the contacts backup came along");
  assert.equal(dav.get(user, "K/Media/abc_photo.jpg"), "jpeg", "the media came along");
  assert.ok(dav.get(user, "K/KaChat Contacts.json"), "the exports came along");
  assert.equal(dav.get(user, "KaChat/kachat-contacts.json"), undefined);
  assert.equal(stored().backupFolder, null, "the default K from here on");
  assert.ok(Number(stored().kFolderCheckedAt) > 0, "settled, remembered with the account");
  // a backup now reads and writes K
  saveAddressBookEntry({ address: BOB, name: "Bob" });
  await runBackup();
  const plain = JSON.parse(await openBackupEnvelope(dav.get(user, "K/kachat-contacts.json"), KEY_HEX, WALLET));
  assert.deepEqual(plain.entries.map((e) => e.address).sort(), [ALICE, BOB].sort(), "K's file has both");
  assert.equal(dav.moves().length, 1, "no second MOVE");
});

test("two callers at once share one run: one root look, one MOVE", async () => {
  fresh();
  dav.put(user, "KaChat/kachat-contacts.json", await sealed([row(ALICE, "Alice")]));
  start();
  await Promise.all([
    migrateLegacyFolderIfNeeded(),
    uploadNextcloudMedia(new Blob(["x"]), "photo.jpg", "image/jpeg"),
    runBackup(),
    migrateLegacyFolderIfNeeded(),
  ]);
  assert.equal(dav.moves().length, 1);
  assert.equal(rootListings(), 1, "the root was looked at once");
  assert.ok(dav.log.some((r) => r.method === "PUT" && /^K\/Media\/[a-z0-9]+_photo\.jpg$/.test(r.path)), "the media went to K/Media");
  assert.ok(!dav.log.some((r) => r.method === "PUT" && r.path.startsWith("KaChat/")), "nothing written to KaChat");
});

test("once settled it isn't looked at again this session, nor for a week; then it is", async () => {
  fresh();
  start();
  await migrateLegacyFolderIfNeeded();
  assert.equal(rootListings(), 1);
  await migrateLegacyFolderIfNeeded();
  assert.equal(rootListings(), 1, "not again this session");
  assert.ok(Number(stored().kFolderCheckedAt) > 0, "the date is kept with the account");
  // The next session (memory empty) reads the stored date. Another server address stands in for a
  // fresh session here: this session's memory is keyed by wallet, server and user.
  const nextSession = (server, daysAgo) => {
    const saved = stored();
    saved.server = server;
    saved.kFolderCheckedAt = Date.now() - daysAgo * 86_400_000;
    local.setItem(accountKey(), JSON.stringify(saved));
    resetNextcloudForAccount();
  };
  nextSession("https://cloud2.example.test", 6);
  await migrateLegacyFolderIfNeeded();
  assert.equal(rootListings(), 1, "six days on, the stored date stands");
  // an older build made KaChat again meanwhile: after the week it is looked at again
  dav.put(user, "KaChat/kachat-contacts.json", await sealed([row(ALICE, "Alice")]));
  nextSession("https://cloud3.example.test", 8);
  await migrateLegacyFolderIfNeeded();
  assert.equal(rootListings(), 2, "eight days on, looked at again");
  assert.equal(dav.moves().length, 1, "a KaChat made again moves (K was missing)");
});

test("both folders with a contacts file: the old one is merged in, never moved over, and once only", async () => {
  fresh();
  dav.put(user, "K/kachat-contacts.json", await sealed([row(BOB, "Bob")]));
  dav.put(user, "KaChat/kachat-contacts.json", await sealed([row(ALICE, "Alice from the old folder")]));
  start();
  await migrateLegacyFolderIfNeeded();
  assert.equal(dav.moves().length, 0, "no MOVE when K exists and holds its own file");
  assert.equal(addressBookEntry(ALICE)?.name, "Alice from the old folder", "the old folder's contact is merged in");
  assert.ok(dav.get(user, "KaChat/kachat-contacts.json"), "the old file stays");
  assert.ok(stored().kFolderMergedEtag, "the merged file's ETag is remembered");
  assert.ok(logs.some((line) => line.includes("Merged the KaChat folder's contacts into K")));
  const gets = () => dav.log.filter((r) => r.method === "GET" && r.path === "KaChat/kachat-contacts.json").length;
  assert.equal(gets(), 1);
  await migrateLegacyFolderIfNeeded({ force: true });
  assert.equal(gets(), 1, "the same old file isn't downloaded again");
  // the merged contact reaches K with the next backup
  await runBackup();
  const plain = JSON.parse(await openBackupEnvelope(dav.get(user, "K/kachat-contacts.json"), KEY_HEX, WALLET));
  assert.deepEqual(plain.entries.map((e) => e.address).sort(), [ALICE, BOB].sort());
});

test("both folders, only the old one with a contacts file: that file is moved into K", async () => {
  fresh();
  dav.dir(user, "K");
  dav.put(user, "K/notes.txt", "mine");
  dav.put(user, "KaChat/kachat-contacts.json", await sealed([row(ALICE, "Alice")]));
  start();
  await migrateLegacyFolderIfNeeded();
  const moves = dav.moves();
  assert.equal(moves.length, 1);
  assert.equal(moves[0].path, "KaChat/kachat-contacts.json");
  assert.equal(moves[0].destination, "K/kachat-contacts.json");
  assert.ok(dav.get(user, "K/kachat-contacts.json"));
  assert.equal(dav.get(user, "K/notes.txt"), "mine", "K's own files are untouched");
});

test("a folder the user picked stays: no root look, no MOVE", async () => {
  fresh({ backupFolder: "Documents/Backups" });
  dav.put(user, "KaChat/kachat-contacts.json", "{}");
  start();
  await migrateLegacyFolderIfNeeded();
  assert.equal(rootListings(), 0);
  assert.equal(dav.moves().length, 0);
  assert.equal(stored().backupFolder, "Documents/Backups");
});

test("a KaChat folder discovery linked is moved like the default", async () => {
  fresh({ backupFolder: "KaChat" });
  dav.put(user, "KaChat/kachat-contacts.json", "{}");
  start();
  await migrateLegacyFolderIfNeeded();
  assert.equal(dav.moves().length, 1);
  assert.equal(stored().backupFolder, null, "the default K, not a stale KaChat");
});

test("a MOVE refused with only KaChat there keeps using KaChat and tries again after a day", async () => {
  fresh();
  dav.put(user, "KaChat/kachat-contacts.json", "{}");
  dav.hook = async ({ method }) => (method === "MOVE" ? new Response("", { status: 403 }) : undefined);
  start();
  await migrateLegacyFolderIfNeeded();
  assert.equal(dav.log.filter((r) => r.method === "MOVE").length, 1);
  assert.equal(stored().backupFolder, "KaChat", "the folder that has the file, meanwhile");
  const retryAt = Number(stored().kFolderRetryAt);
  assert.ok(retryAt > Date.now() + 23 * 3600_000 && retryAt <= Date.now() + 24 * 3600_000 + 1000, "a day on");
  assert.ok(!stored().kFolderCheckedAt, "not settled");
  await migrateLegacyFolderIfNeeded();
  assert.equal(dav.log.filter((r) => r.method === "MOVE").length, 1, "not every call retries");
  dav.hook = null;
  nowOffset = 25 * 3600_000;
  await migrateLegacyFolderIfNeeded();
  assert.equal(dav.moves().length, 2, "a day later it is tried again, and works");
  assert.equal(stored().backupFolder, null);
  assert.ok(dav.get(user, "K/kachat-contacts.json") != null);
});

test("a failed MOVE that moved after all (another device) is taken as done", async () => {
  fresh();
  dav.put(user, "KaChat/kachat-contacts.json", "{}");
  dav.hook = async ({ method, path }) => {
    if (method !== "MOVE" || path !== "KaChat") return undefined;
    // the other device's MOVE lands, ours is answered with an error
    for (const [file, body] of [...dav.files]) if (file.startsWith(`${user}/KaChat/`)) { dav.files.delete(file); dav.files.set(file.replace(`${user}/KaChat/`, `${user}/K/`), body); }
    dav.dirs.delete(`${user}/KaChat`);
    dav.dirs.add(`${user}/K`);
    return new Response("", { status: 502 });
  };
  start();
  await migrateLegacyFolderIfNeeded();
  assert.equal(stored().backupFolder, null);
  assert.ok(Number(stored().kFolderCheckedAt) > 0, "settled");
  assert.ok(!stored().kFolderRetryAt);
});

test("discovery takes a bare K or KaChat folder only at the root, with the exact name", async () => {
  // a "k" three levels down is someone's own folder
  fresh({ backupFolderScanned: 0 });
  dav.dir(user, "Notes/old/k");
  dav.dir(user, "kachat");
  start();
  await sleep(50);
  assert.equal(stored().backupFolder, null, "nothing linked");
  assert.equal(dav.moves().length, 0, "nothing moved: lower-case kachat is not ours");
  // a root KaChat (no contacts file in it) is linked, then moved to K straight away
  fresh({ backupFolderScanned: 0 });
  dav.dir(user, "KaChat/Media");
  start();
  await sleep(50);
  assert.equal(dav.moves().length, 1);
  assert.equal(stored().backupFolder, null, "linked, then the default K after the move");
  assert.ok(dav.dirs.has(`${user}/K/Media`));
  const source = readFileSync(new URL("../ui/nextcloud.js", import.meta.url), "utf8");
  assert.match(source, /if \(!namedCandidate && !path && \[DEFAULT_BACKUP_FOLDER, LEGACY_BACKUP_FOLDER\]\.includes\(entry\.name\)\)/);
});

test("every way in settles the move first: backup, backup info, watcher, uploads and the picker", () => {
  const source = readFileSync(new URL("../ui/nextcloud.js", import.meta.url), "utf8");
  const body = (name) => {
    const at = source.search(new RegExp(`(?:async )?function ${name}\\(`));
    assert.ok(at >= 0, name);
    return source.slice(at, source.indexOf("\n}\n", at));
  };
  for (const name of ["performBackup", "fetchBackupInfo", "runChangeWatcher", "uploadNextcloudMedia", "uploadToKaChatFolder", "loadPickerFolder"]) {
    assert.match(body(name), /await migrateLegacyFolderIfNeeded\(\)/, name);
  }
  assert.match(body("performBackup"), /fetchBackupInfo\(\{ migrate: false \}\)/, "a backup runs it once, not twice");
  assert.match(body("adoptExistingBackupFolder"), /migrateLegacyFolderIfNeeded\(\{ force: true \}\)/, "connect looks now");
});

// --- Run ------------------------------------------------------------------------------------------

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL - ${name}\n`, error);
  }
}
await vite.close();
if (failed) { console.error(`${failed} of ${tests.length} failed`); process.exit(1); }
console.log(`all ${tests.length} passed`);
process.exit(0);
