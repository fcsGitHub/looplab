// Researcher account: real evolution data + one live optimizer round.
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.E2E_BASE ?? "http://localhost:8080";
const OUT = "docs/evidence/ui-overhaul";
fs.mkdirSync(OUT, { recursive: true });
const errors = [];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(BASE);
await page.getByLabel("用户名").fill("researcher");
await page.getByLabel("密码").fill("looplab");
await page.getByRole("button", { name: "登录", exact: true }).click();
await page.getByText("项目").waitFor({ timeout: 15000 });

// pick the algorithm-search project, then a trial session
await page.getByRole("button", { name: /CPU 算法搜索/ }).click();
await page.waitForTimeout(800);
const trial = page.getByRole("button", { name: /元演进试炼|epoch 试炼/ }).first();
if (await trial.count()) await trial.click();
else await page.locator(".session-list .side-item").first().click();
await page.locator(".conn.on").waitFor({ timeout: 30000 });
console.log("session opened");

await page.getByRole("tab", { name: /演进与版本/ }).click();
// let SSE backlog replay + runs load
await page.waitForTimeout(5000);
await page.screenshot({ path: `${OUT}/30-evo-real.png`, fullPage: false });
await page.screenshot({ path: `${OUT}/30-evo-real-full.png`, fullPage: true });

// trigger one live optimizer round (UI button, fixed empty-body bug)
await page.getByRole("button", { name: /运行一轮优化/ }).click();
await page.waitForTimeout(3000);
await page.screenshot({ path: `${OUT}/31-round-dispatched.png` });
for (let i = 0; i < 8; i++) {
  await page.waitForTimeout(20000);
  await page.screenshot({ path: `${OUT}/32-round-live-${i + 1}.png` });
  const running = await page.locator(".opt-row.running").count();
  const rows = await page.locator(".opt-row").count();
  console.log(`t+${(i + 1) * 20}s runs=${rows} running=${running}`);
  if (rows > 0 && running === 0 && i >= 2) break;
}

await browser.close();
fs.writeFileSync(`${OUT}/researcher-console-errors.json`, JSON.stringify(errors, null, 2));
console.log("done. console errors:", errors.length);
for (const e of errors.slice(0, 8)) console.log(" -", e.slice(0, 200));
