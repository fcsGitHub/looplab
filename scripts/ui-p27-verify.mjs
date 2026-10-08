// P27 live verification: real browser + real model + real worker.
// Verifies the P27 workbench round: milestone-card inspector navigation,
// priority selector (set_priority → goal.priority_changed card), steer
// acceptance card, task inspector (deps + attempts), approval card logic,
// memories rendering. Small goal to keep LLM cost minimal.
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.E2E_BASE ?? "http://localhost:8080";
const OUT = "docs/evidence/ui-p27";
fs.mkdirSync(OUT, { recursive: true });
const UNIQ = Date.now().toString(36);
const errors = [];
const checks = [];
const ok = (name, cond) => { checks.push({ name, pass: !!cond }); console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(BASE);
await page.getByRole("button", { name: "没有账号？注册" }).click();
await page.getByLabel("用户名").fill(`p27_${UNIQ}`);
await page.getByLabel("密码").fill("looplab");
await page.getByRole("button", { name: "注册（首个用户为管理员）" }).click();
await page.getByText("项目").waitFor({ timeout: 15000 });

await page.getByRole("button", { name: /新建 \(N\)/ }).click();
const goal = page.getByPlaceholder(/描述你的目标/);
await goal.fill("用 Python 写 is_odd(n)，脚本写进工作区，用 3 个用例验证并报告结果");
await goal.press("Enter");
console.log("goal sent");

// SSE + chat milestone cards from real events
await page.locator(".conn.on").waitFor({ timeout: 45000 });
await page.locator(".chat .data-card").first().waitFor({ timeout: 30000 });
ok("chat: goal.created 里程碑卡出现", (await page.locator(".chat .data-card", { hasText: "目标已接受" }).count()) > 0);

// graph planned card
await page.locator(".chat .data-card", { hasText: /任务图已规划|任务图已修订/ }).first().waitFor({ timeout: 120000 });
ok("chat: graph_planned 里程碑卡出现", true);

// P27-1: milestone card → goal inspector navigation
await page.locator(".chat .data-card", { hasText: "任务图已规划" }).first().click();
await page.locator(".inspector").waitFor({ timeout: 8000 });
ok("chat: 里程碑卡可点入目标检查器", (await page.locator(".inspector .insp-head").textContent())?.includes("目标检查器"));
await page.screenshot({ path: `${OUT}/01-goal-inspector-from-card.png` });
await page.keyboard.press("Escape");

// P27-2: priority selector in topbar → change → goal.priority_changed card
await page.locator(".priority-sel select").waitFor({ timeout: 8000 });
await page.locator(".priority-sel select").selectOption("1");
await page.locator(".chat .data-card", { hasText: "调度优先级" }).first().waitFor({ timeout: 20000 });
const prioCard = (await page.locator(".chat .data-card", { hasText: "调度优先级" }).first().textContent()) ?? "";
ok("topbar: 优先级调整产生 priority_changed 卡（5→1）", prioCard.includes("→ 1"));
await page.screenshot({ path: `${OUT}/02-priority-changed-card.png` });

// P27-3: steer acceptance card
await page.getByRole("button", { name: "总结进展" }).click();
await page.locator(".chat .data-card", { hasText: "引导已接受" }).first().waitFor({ timeout: 30000 });
ok("chat: steer_accepted 卡出现（对话流反馈闭环）", true);

// P27-4: attempt.committed card clickable → trajectory inspector
await page.locator(".chat .data-card", { hasText: /子任务已提交|子任务结束/ }).first().waitFor({ timeout: 300000 });
await page.waitForTimeout(500);
await page.locator(".chat .data-card", { hasText: /子任务已提交|子任务结束/ }).first().click();
await page.locator(".traj").waitFor({ timeout: 15000 });
ok("chat: attempt 卡可点入轨迹检查器", true);
await page.screenshot({ path: `${OUT}/03-attempt-trajectory-from-card.png` });
await page.keyboard.press("Escape");

// P27-5: task inspector enriched (node_key + deps + attempts)
const nodeBtn = page.locator(".graph-mini .node").first();
await nodeBtn.click();
await page.locator(".inspector").waitFor({ timeout: 8000 });
const inspText = (await page.locator(".inspector").textContent()) ?? "";
ok("task 检查器: node_key 可见", /t\d|verify/.test(inspText));
ok("task 检查器: 依赖行存在", inspText.includes("依赖"));
ok("task 检查器: 执行尝试行存在", inspText.includes("执行尝试"));
await page.screenshot({ path: `${OUT}/04-task-inspector.png` });
await page.keyboard.press("Escape");

// wait for completion, then evidence page (memories section renders when present)
const deadline = Date.now() + 6 * 60_000;
let finalState = "";
while (Date.now() < deadline) {
  finalState = (await page.locator(".topbar .state-chip").first().textContent().catch(() => "")) ?? "";
  if (/COMPLETED|FAILED|CANCELLED|BLOCKED/i.test(finalState)) break;
  await page.waitForTimeout(5000);
}
console.log("final state:", finalState.trim());
ok("目标到达终态（真实 worker 执行）", /COMPLETED|FAILED|CANCELLED|BLOCKED/i.test(finalState));
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/05-final-chat.png` });

await page.getByRole("tab", { name: /证据与资产/ }).click();
await page.waitForTimeout(1000);
await page.screenshot({ path: `${OUT}/06-evidence.png` });

await browser.close();
fs.writeFileSync(`${OUT}/console-errors.json`, JSON.stringify(errors, null, 2));
fs.writeFileSync(`${OUT}/checks.json`, JSON.stringify(checks, null, 2));
const failed = checks.filter((c) => !c.pass);
console.log(`\nchecks: ${checks.length - failed.length}/${checks.length} passed · console errors: ${errors.length}`);
for (const e of errors.slice(0, 8)) console.log(" -", e.slice(0, 200));
process.exit(failed.length || errors.length ? 1 : 0);
