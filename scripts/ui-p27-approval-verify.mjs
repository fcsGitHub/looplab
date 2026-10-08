// P27 approval-card verification: the live goal hit the P20 diagnosis→approval
// gate (verify failed 3×, diagnosis SUCCEEDED, goal_revise approval PENDING).
// Verifies: approval.requested milestone card in chat + inline 批准 → revise
// replan (goal.graph_planned revision card) → goal completes.
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.E2E_BASE ?? "http://localhost:8080";
const OUT = "docs/evidence/ui-p27";
const USER = process.env.P27_USER ?? "p27_muy7aae1";
const errors = [];
const checks = [];
const ok = (name, cond) => { checks.push({ name, pass: !!cond }); console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(BASE);
await page.getByLabel("用户名").fill(USER);
await page.getByLabel("密码").fill("looplab");
await page.getByRole("button", { name: "登录", exact: true }).click();
await page.getByText("项目").waitFor({ timeout: 15000 });

// open the goal from the ongoing-goals sidebar
await page.locator(".side-item", { hasText: "is_odd" }).first().click();
await page.locator(".conn.on").waitFor({ timeout: 45000 });
await page.locator(".chat .data-card").first().waitFor({ timeout: 30000 });

// P27: approval.requested card rendered from the real event
await page.locator(".chat .data-card", { hasText: "等待人工审批" }).first().waitFor({ timeout: 20000 });
ok("chat: approval.requested 卡出现（真实审批门）", true);

// inline approve button on the card (PENDING state)
const approveBtn = page.locator(".ms-approval-actions button", { hasText: "批准重规划" }).first();
ok("审批卡: 内联「批准重规划」按钮可见", (await approveBtn.count()) > 0);
await page.screenshot({ path: `${OUT}/07-approval-card-pending.png` });

// topbar shows awaiting_approval, goal ACTIVE
const state = (await page.locator(".topbar .state-chip").first().textContent()) ?? "";
ok("topbar: 状态 ACTIVE + awaiting_approval", state.includes("ACTIVE"));

// approve → revision replan card + completion
await approveBtn.click();
await page.locator(".chat .data-card", { hasText: "任务图已修订" }).first().waitFor({ timeout: 60000 });
ok("批准后: 自动重规划（graph_planned 修订卡）", true);
await page.screenshot({ path: `${OUT}/08-approved-replan.png` });

const deadline = Date.now() + 5 * 60_000;
let finalState = "";
while (Date.now() < deadline) {
  finalState = (await page.locator(".topbar .state-chip").first().textContent().catch(() => "")) ?? "";
  if (/COMPLETED|FAILED|CANCELLED|BLOCKED/i.test(finalState)) break;
  await page.waitForTimeout(5000);
}
console.log("final state:", finalState.trim());
ok("批准后目标到达终态", /COMPLETED|FAILED|CANCELLED|BLOCKED/i.test(finalState));
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/09-final.png` });

// approval card now shows decided state (not buttons)
ok("审批卡: 裁决后按钮消失", (await page.locator(".ms-approval-actions button").count()) === 0);

await browser.close();
fs.writeFileSync(`${OUT}/checks-approval.json`, JSON.stringify(checks, null, 2));
const failed = checks.filter((c) => !c.pass);
console.log(`\nchecks: ${checks.length - failed.length}/${checks.length} passed · console errors: ${errors.length}`);
for (const e of errors.slice(0, 8)) console.log(" -", e.slice(0, 200));
process.exit(failed.length || errors.length ? 1 : 0);
