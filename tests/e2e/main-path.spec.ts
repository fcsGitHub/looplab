// E2E: real browser against the real control service + real worker + real LLM.
// Covers the user main path: register -> new session -> goal -> live events ->
// pause/resume -> evidence. Screenshots are written to docs/evidence/e2e/.
import { test, expect } from "@playwright/test";

const BASE = process.env.E2E_BASE ?? "http://localhost:8080";
const UNIQ = Date.now().toString(36);

test.describe.configure({ mode: "serial" });

test("main path: register, create session, send goal, observe live execution", async ({ page }) => {
  test.setTimeout(1400_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(BASE);

  // register a fresh user (first-run friendly)
  await page.getByRole("button", { name: "没有账号？注册" }).click();
  await page.getByLabel("用户名").fill(`e2e_${UNIQ}`);
  await page.getByLabel("密码").fill("looplab");
  await page.getByRole("button", { name: "注册（首个用户为管理员）" }).click();
  await expect(page.getByText("项目")).toBeVisible({ timeout: 15_000 });

  // new session
  await page.getByRole("button", { name: /新建 \(N\)/ }).click();
  const goalInput = page.getByPlaceholder(/描述你的目标/);
  await expect(goalInput).toBeEnabled({ timeout: 20_000 });

  // send a real goal (real LLM planning + worker execution)
  await goalInput.fill(
    "用 Python 计算 1 到 5000 的所有素数个数，把脚本写进工作区并运行验证，最后报告个数",
  );
  await goalInput.press("Enter");

  // goal card appears with a live SSE connection
  await expect(page.locator(".conn.on")).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText(/goal_\w+@\d/).first()).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: "docs/evidence/e2e/01-goal-planned.png", fullPage: false });

  // tasks appear in the graph view (real planner output)
  await expect(page.locator(".graph-mini .node").first()).toBeVisible({ timeout: 90_000 });

  // pause and resume via UI (accepted ≠ applied is respected by the server)
  await page.getByRole("button", { name: /暂停 \(P\)/ }).click();
  await expect(page.locator(".state-chip.paused_user, .state-chip:has-text('PAUSED_USER')").first()).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: "docs/evidence/e2e/02-paused.png" });
  await page.getByRole("button", { name: /恢复 \(P\)/ }).click();
  await expect(page.locator(".state-chip:has-text('ACTIVE'), .state-chip.active").first()).toBeVisible({ timeout: 20_000 });

  // runs view shows real attempts with costs
  await page.getByRole("tab", { name: /运行记录/ }).click();
  await expect(page.locator(".run-row").first()).toBeVisible({ timeout: 90_000 });
  await page.screenshot({ path: "docs/evidence/e2e/03-runs.png" });

  // evidence view works (artifacts from real tool execution)
  await page.getByRole("tab", { name: /证据与资产/ }).click();
  await expect(page.locator(".ws-body, .empty").first()).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: "docs/evidence/e2e/04-evidence.png" });

  // P23: hold the main path open until the goal ACTUALLY completes — the
  // chain only counts when the real model, real worker and verify node all
  // finish (previously the e2e stopped mid-execution). A strict verify node
  // may park the goal behind a goal_revise approval (diagnosis gate): approve
  // it from the UI (at most twice) and keep waiting for COMPLETED.
  await page.getByRole("tab", { name: /当前工作/ }).click();
  let approvalsClicked = 0;
  await expect
    .poll(async () => {
      const done = await page
        .locator(".state-chip.completed, .state-chip:has-text('COMPLETED')")
        .count();
      if (done > 0) return "completed";
      if (approvalsClicked < 2) {
        const approveBtn = page.locator(".approval-strip .approval-item").first().getByRole("button", { name: "批准" });
        if ((await approveBtn.count()) > 0) {
          await approveBtn.click();
          approvalsClicked++;
        }
      }
      return "pending";
    }, { timeout: 1200_000, intervals: [5_000] })
    .toBe("completed");
  await page.screenshot({ path: "docs/evidence/e2e/05-completed.png", fullPage: false });
});

test("unauthenticated SSE is rejected (no event leak)", async ({ request }) => {
  const res = await request.get(`${BASE}/v1/events`);
  expect(res.status()).toBe(401);
});
