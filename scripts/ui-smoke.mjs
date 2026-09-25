// UI overhaul smoke: real browser against running control (no LLM spend).
// Verifies: auth, new session, empty states, system modal, theme toggle,
// evolution/trajectory empty states; captures console errors + screenshots.
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

await page.goto(BASE, { waitUntil: "networkidle" });
await page.screenshot({ path: `${OUT}/00-login.png` });

// register fresh user
await page.getByRole("button", { name: "没有账号？注册" }).click();
await page.getByLabel("用户名").fill(`ui_${UNIQ}`);
await page.getByLabel("密码").fill("looplab");
await page.getByRole("button", { name: "注册（首个用户为管理员）" }).click();
await page.getByText("项目").waitFor({ timeout: 15000 });

// new session → empty goal state
await page.getByRole("button", { name: /新建 \(N\)/ }).click();
await page.getByPlaceholder(/描述你的目标/).waitFor({ timeout: 15000 });
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/01-empty-session.png` });

// workspace tabs (empty states)
for (const [name, file] of [["运行记录", "02-runs-empty"], ["演进与版本", "03-evolution-empty"], ["证据与资产", "04-evidence-empty"]]) {
  await page.getByRole("tab", { name }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/${file}.png` });
}

// system modal
await page.getByRole("tab", { name: "当前工作" }).click();
await page.getByRole("button", { name: "系统设置与指标" }).click();
await page.waitForTimeout(700);
await page.screenshot({ path: `${OUT}/05-system-modal.png` });
await page.keyboard.press("Escape");

// light theme
await page.getByRole("button", { name: "切换主题" }).click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/06-light-theme.png` });
await page.getByRole("button", { name: "切换主题" }).click();

await browser.close();
fs.writeFileSync(`${OUT}/console-errors.json`, JSON.stringify(errors, null, 2));
console.log("smoke done. console errors:", errors.length);
for (const e of errors.slice(0, 10)) console.log(" -", e.slice(0, 200));
