// node tools/test-ios-5-3-kapay.mjs - the rest of KaPay iOS 5848fb0, ported in Build 296: Portfolio
// numbers in any script and capped at the supply, KasSigner sends kept out of the orphan pool and
// shown at the amount they build, a removed cold account's coin labels, and the push watch list
// newest first with only covered addresses announced by push.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(repo, p), "utf8");

let failures = 0;
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); }
  catch (error) { failures += 1; console.log(`FAIL - ${name}\n`, error); }
}

// The parser on its own (ui/portfolio.js imports the app's assets, so it's lifted out here).
async function portfolioParser() {
  const src = read("ui/portfolio.js");
  const start = src.indexOf("const isDecimalDigit");
  const fnStart = src.indexOf("export function parsePortfolioNumber");
  const fnEnd = src.indexOf("\n}\n", fnStart) + 3;
  const code = `const DECIMAL_SEPARATORS = { decimal: "." };\n${src.slice(start, fnEnd).replace("export function", "function")}\nexport { parsePortfolioNumber };`;
  return import(`data:text/javascript,${encodeURIComponent(code)}`);
}

await test("Portfolio reads digits in any script", async () => {
  const { parsePortfolioNumber } = await portfolioParser();
  assert.equal(parsePortfolioNumber("٥٠"), 50, "Arabic-Indic");
  assert.equal(parsePortfolioNumber("١٢٫٥"), 12.5, "with the Arabic decimal mark");
  assert.equal(parsePortfolioNumber("١٬٢٣٤٫٥"), 1234.5, "and its thousands mark");
  assert.equal(parsePortfolioNumber("५०"), 50, "Devanagari");
  assert.equal(parsePortfolioNumber("𝟓𝟎"), 50, "mathematical digits");
  assert.equal(parsePortfolioNumber("1,234.56"), 1234.56, "ASCII as before");
});
await test("Portfolio amounts are capped at the supply, in the editor, adds and CSV", async () => {
  const { PORTFOLIO_MAX_KAS } = await import("../ui/portfolio-sync.js");
  assert.equal(PORTFOLIO_MAX_KAS, 29_000_000_000);
  const pf = read("ui/portfolio.js");
  assert.match(pf, /quantity <= PORTFOLIO_MAX_KAS/);
  assert.match(pf, /if \(!\(Math\.abs\(Number\(amountKas\) \|\| 0\) <= PORTFOLIO_MAX_KAS\)\) return;/);
  assert.match(read("ui/portfolio-sync.js"), /if \(kas !== null && Math\.abs\(kas\) > PORTFOLIO_MAX_KAS\) continue;/);
});
await test("a KasSigner send never waits in an orphan pool, and shows the amount it builds", () => {
  assert.match(read("ui/kspt.js"), /escalateOrphan: false,\n\s+label: "Cold storage broadcast",/);
  assert.match(read("ui/coldstorage.js"), /const builtOut = unsigned\?\.outputs\?\.\[0\]\?\.valueSompi;/);
});
await test("removing a cold account removes its coin labels, unless another watches the same key", () => {
  const cs = read("ui/coldstorage.js");
  assert.match(cs, /if \(!accounts\.some\(\(a\) => a\.kpub === account\.kpub\)\) dropColdUtxoLabelsFor\(account\);/);
  assert.match(cs, /function dropColdUtxoLabelsFor\(account\)/);
});
await test("the push watch list goes newest first, and only covered addresses count on push", () => {
  const app = read("ui/app.js");
  assert.match(app, /watchOnly = \[\.\.\.ofKind\(\(kind\) => kind !== "cold"\), \.\.\.ofKind\(\(kind\) => kind === "cold"\)\];/);
  assert.match(app, /pushWatchOnlyCovered = new Set\(watchOnly\.slice\(0, PUSH_LIMITS\.watchOnly\)/);
  assert.match(app, /const mayFallBack = !isChatting && !pushShowsReceive\(address\);/);
});

if (failures) { console.log(`${failures} failed`); process.exit(1); }
console.log(`ios 5.3 kapay: ${passed} passed`);
