// RSI curve live verification: login as the live user, open evolution view,
// trigger one optimizer round, capture the burn curve updating over time.
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
await page.getByLabel("用户名").fill("live_mugs7z4h");
await page.getByLabel("密码").fill("looplab");
await page.getByRole("button", { name: "登录", exact: true }).click();
await page.getByText("项目").waitFor({ timeout: 15000 });

await page.getByRole("button", { name: /新会话/ }).first().click();
await page.locator(".conn.on").waitFor({ timeout: 30000 });

await page.getByRole("tab", { name: /演进与版本/ }).click();
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/20-evo-before-round.png` });

await page.getByRole("button", { name: /运行一轮优化/ }).click();
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/21-evo-round-dispatched.png` });

for (let i = 0; i < 6; i++) {
  await page.waitForTimeout(20000);
  await page.screenshot({ path: `${OUT}/22-evo-live-${i + 1}.png` });
  const runs = await page.locator(".opt-row").count();
  console.log(`t+${(i + 1) * 20}s optimizer run rows: ${runs}`);
}

await browser.close();
fs.writeFileSync(`${OUT}/opt-console-errors.json`, JSON.stringify(errors, null, 2));
console.log("optimizer live done. console errors:", errors.length);
for (const e of errors.slice(0, 8)) console.log(" -", e.slice(0, 200));
