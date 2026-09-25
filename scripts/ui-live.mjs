// Live-goal UI verification: real LLM + real worker, small cheap goal.
// Captures: DAG work view, live trajectory, evolution console, final state.
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.E2E_BASE ?? "http://localhost:8080";
const OUT = "docs/evidence/ui-overhaul";
fs.mkdirSync(OUT, { recursive: true });
const UNIQ = Date.now().toString(36);
const errors = [];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(BASE);
await page.getByRole("button", { name: "没有账号？注册" }).click();
await page.getByLabel("用户名").fill(`live_${UNIQ}`);
await page.getByLabel("密码").fill("looplab");
await page.getByRole("button", { name: "注册（首个用户为管理员）" }).click();
await page.getByText("项目").waitFor({ timeout: 15000 });

await page.getByRole("button", { name: /新建 \(N\)/ }).click();
const goal = page.getByPlaceholder(/描述你的目标/);
await goal.fill("用 Python 写 is_prime(n)，把脚本写进工作区并用 8 个用例验证，最后报告结果");
await goal.press("Enter");
console.log("goal sent");

// SSE connect + goal planned
await page.locator(".conn.on").waitFor({ timeout: 45000 });
await page.locator(".graph-mini .node").first().waitFor({ timeout: 120000 });
console.log("tasks planned");
await page.waitForTimeout(3000);
await page.screenshot({ path: `${OUT}/10-work-dag.png` });

// wait for an attempt row, open trajectory
await page.getByRole("tab", { name: /运行记录/ }).click();
await page.locator(".run-row").first().waitFor({ timeout: 120000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/11-runs.png` });
await page.locator(".run-row").first().click();
await page.locator(".traj").waitFor({ timeout: 15000 });
console.log("trajectory open");
// let events accumulate
await page.waitForTimeout(25000);
await page.screenshot({ path: `${OUT}/12-trajectory.png` });
// expand first expandable row
const summary = page.locator(".traj-summary:not([disabled])").first();
if (await summary.count()) { await summary.click(); await page.waitForTimeout(400); }
await page.screenshot({ path: `${OUT}/13-trajectory-expanded.png` });
await page.keyboard.press("Escape");

// evolution console
await page.getByRole("tab", { name: /演进与版本/ }).click();
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/14-evolution.png` });

// wait for completion (poll state chip), then final shots
await page.getByRole("tab", { name: /当前工作/ }).click();
const deadline = Date.now() + 6 * 60_000;
let finalState = "";
while (Date.now() < deadline) {
  finalState = (await page.locator(".topbar .state-chip").first().textContent().catch(() => "")) ?? "";
  if (/COMPLETED|FAILED|CANCELLED/i.test(finalState)) break;
  await page.waitForTimeout(5000);
}
console.log("final state:", finalState.trim());
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/15-final-work.png` });
await page.getByRole("tab", { name: /运行记录/ }).click();
await page.locator(".run-row").first().click();
await page.locator(".traj").waitFor({ timeout: 15000 });
await page.waitForTimeout(2000);
await page.screenshot({ path: `${OUT}/16-final-trajectory.png` });

await browser.close();
fs.writeFileSync(`${OUT}/live-console-errors.json`, JSON.stringify(errors, null, 2));
console.log("live done. console errors:", errors.length);
for (const e of errors.slice(0, 8)) console.log(" -", e.slice(0, 200));
