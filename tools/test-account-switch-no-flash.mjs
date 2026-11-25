// node tools/test-account-switch-no-flash.mjs - switching accounts shows the loading globe between
// the Log Out and the sign-in, never the sign-in screen (K 961fc05a WalletManager.isSwitchingAccount,
// ContentView; owner 2026-11-25: "it should be a seamless transfer to another profile"). Desktop's
// globe is the launch screen (index.html .boot-splash, "K 5.3 (N)"), shown again over the signed-out
// screen while ui/account-switcher.js runAccountSwitch runs; the password prompt sits over it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runAccountSwitch } from "../ui/account-switcher.js";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const app = read("ui/app.js");
const css = read("ui/styles.css");
const html = read("index.html");
const between = (source, start, end) => {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `missing ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to > from, `missing ${end}`);
  return source.slice(from, to);
};

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); } catch (error) { console.error(`not ok - ${name}`); throw error; }
}

/** A switch with its steps recorded: what the screen shows at each one. */
function harness({ logOutWorks = true, signIn = true, signInThrows = false } = {}) {
  const steps = [];
  let switching = false;
  let signedIn = true;
  const result = runAccountSwitch({
    setSwitching: (on) => { switching = on; steps.push(on ? "globe on" : "globe off"); },
    logOut: async () => { steps.push(`log out (globe ${switching ? "up" : "down"})`); if (logOutWorks) signedIn = false; },
    signedOut: () => !signedIn,
    signIn: async () => {
      steps.push(`sign in (globe ${switching ? "up" : "down"})`);
      if (signInThrows) throw new Error("vault");
      return signIn;
    },
  });
  return { result, steps, isSwitching: () => switching };
}

await test("the globe goes up before Log Out and stays up through the sign-in into the reload", async () => {
  const { result, steps, isSwitching } = harness();
  assert.equal(await result, true);
  assert.deepEqual(steps, ["globe on", "log out (globe up)", "sign in (globe up)"]);
  assert.equal(isSwitching(), true, "left up: the reload's own launch screen follows it");
});

await test("a cancelled or failed sign-in ends on the sign-in screen, with the globe gone", async () => {
  const cancelled = harness({ signIn: false });
  assert.equal(await cancelled.result, false);
  assert.deepEqual(cancelled.steps, ["globe on", "log out (globe up)", "sign in (globe up)", "globe off"]);
  const failed = harness({ signInThrows: true });
  await assert.rejects(failed.result, /vault/);
  assert.equal(failed.isSwitching(), false);
});

await test("a Log Out that didn't finish changes nothing else", async () => {
  const { result, steps, isSwitching } = harness({ logOutWorks: false });
  assert.equal(await result, false);
  assert.deepEqual(steps, ["globe on", "log out (globe up)", "globe off"], "no sign-in");
  assert.equal(isSwitching(), false);
});

await test("the switcher's switch runs through it, the globe a class on <html>", () => {
  const sw = between(app, "async function switchToSavedAccount(", "profileAccountChip?.addEventListener");
  assert.match(sw, /return runAccountSwitch\(\{\n\s*setSwitching: setAccountSwitching,\n\s*logOut: \(\) => performLogout\(\),\n\s*signedOut: \(\) => !engine\.address,/);
  assert.match(sw, /signIn: \(\) => signInToSavedAccount\(\{ address: account\.address, name: account\.name \}\),/);
  assert.match(sw, /document\.documentElement\.classList\.toggle\("account-switching", Boolean\(on\)\);/);
  assert.match(sw, /setAccountSwitching\(false\); \}, 60_000\);/, "a held-back reload never leaves the page under the globe");
  // the sign-in answers true only once the reload is on its way
  const signIn = between(app, "async function signInToSavedAccount(account)", "function savedAccountAvatarHtml(");
  assert.match(signIn, /activateSavedAccount\(account\.address\);\n\s*reloadKaChat\(\); \/\/ held until the page goes\n\s*return true;/);
});

await test("the globe is the launch screen, under the password prompt and dialogs, over the sign-in screen", () => {
  assert.match(html, /<div class="boot-splash" aria-hidden="true"><img src="\.\/ui\/assets\/kaspa-logo\.png" alt="" \/><span class="boot-splash-version">%KACHAT_VERSION_LABEL%<\/span><\/div>/);
  const rule = /html\.app-ready\.account-switching \.boot-splash \{ display: flex; z-index: (\d+); animation: none; pointer-events: auto; \}/.exec(css);
  assert.ok(rule, "shown again while switching, with no fade-out");
  const z = Number(rule[1]);
  const zOf = (selector) => Number(new RegExp(`${selector.replace(/[[\]().-]/g, "\\$&")} \\{ z-index: (\\d+); \\}`).exec(css)?.[1]);
  assert.ok(z < zOf("[data-password-modal]"), "the password prompt shows over the globe");
  assert.ok(z < zOf(".app-dialog-backdrop"), "and Sign In Failed");
  assert.ok(z > zOf(".account-overlay.over-logged-out"), "and the globe over the signed-out screen's sheets");
  assert.ok(css.indexOf("html.app-ready .boot-splash { display: none; }") < css.indexOf("html.app-ready.account-switching .boot-splash"), "after the rule that hides it");
});

console.log(`account switch without the sign-in flash: ${passed} passed`);
