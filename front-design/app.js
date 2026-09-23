/* ═══════════════════════════════════════════════════════════════
   LoopLab 工作台 · 样机交互层 v2
   主 Agent 摘要 / 子 Agent 执行 / 任务状态栏 / 对话 / 极简工作区
   数据来自 DEMO fixture（demo-data.js），形状见 api-contract.md
   ═══════════════════════════════════════════════════════════════ */
"use strict";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const STATE_META = {
  draft:     { label: "草稿",     chip: "" },
  active:    { label: "运行中",   chip: "chip-active" },
  paused:    { label: "已暂停",   chip: "chip-paused" },
  waiting:   { label: "等待预算", chip: "chip-waiting" },
  cancelled: { label: "已取消",   chip: "chip-cancelled" }
};
const MA_STATUS = { running: "chip-active", paused: "chip-paused", waiting: "chip-waiting" };
const SA_STATUS = { running: "运行中", waiting: "等待", paused: "已暂停", done: "完成", failed: "失败" };
const TASK_META = {
  SUCCEEDED: ["st-done", "成功"], RUNNING: ["st-run", "运行"], READY: ["st-info", "就绪"],
  WAITING: ["st-wait", "等待"], WAITING_BUDGET: ["st-wait", "等预算"],
  PAUSED: ["st-wait", "已暂停"], FAILED: ["st-fail", "失败"], CANCELLED: ["st-fail", "已取消"]
};
const CAND_STATUS = {
  PROPOSED: "已提案", BUILT: "已构建", EVALUATING: "评测中", INCONCLUSIVE: "证据不足",
  ELIGIBLE: "可发布", CANARY: "灰度中", RELEASED: "已发布", REJECTED: "已拒绝", ROLLED_BACK: "已回滚"
};
const STANCE_PILL = { ok: "pill-ok", warn: "pill-warn", bad: "pill-bad" };
const ROLE_SHORT = { Coordinator: "C", Builder: "B", Researcher: "R", Experimenter: "E", Reviewer: "V", Curator: "Cu" };

let sessions = structuredClone(DEMO.sessions);
let currentId = sessions[0].id;
let cursor = "evt_a21f";
let openTrace = -1;   // 轨迹展开行
let taskPopOpen = false;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const current = () => sessions.find((s) => s.id === currentId);

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}
const shortBudget = (s) => {
  const m = (s || "").match(/¥([\d.]+)\s*\/\s*¥([\d.]+)/);
  return m ? `¥${m[1]}/¥${m[2]}` : "";
};

/* ---------- 会话列表 ---------- */
function renderSessions() {
  const nav = $("#session-list");
  nav.innerHTML = sessions.map((s) => {
    const m = STATE_META[s.state] || STATE_META.draft;
    return `<button class="sb-item ${s.id === currentId ? "is-current" : ""}" data-id="${s.id}" data-state="${s.state}" aria-current="${s.id === currentId}">
      <span class="sb-item-name">${esc(s.title)}</span>
      <span class="sb-item-meta">${esc(m.label)} · ${esc(s.updatedAt)}</span></button>`;
  }).join("");
  $$(".sb-item", nav).forEach((b) => b.addEventListener("click", () => {
    switchSession(b.dataset.id);
    closeSidebarDrawer();
  }));
}
function switchSession(id) {
  currentId = id; openTrace = -1; closeTaskPop();
  renderAll();
  simulateReconnect();
}

/* ---------- 顶栏 ---------- */
function renderTopbar() {
  const s = current();
  $("#tb-goal-title").textContent = s.title;
  const meta = STATE_META[s.state] || STATE_META.draft;
  const chip = $("#tb-status");
  chip.className = "chip " + meta.chip;
  chip.innerHTML = (s.state === "active" ? '<span class="pulse-dot" aria-hidden="true"></span>' : "") + esc(meta.label);
  const pauseBtn = $("#btn-pause");
  pauseBtn.innerHTML = s.state === "paused"
    ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 8l2.6 2.6L11.5 5" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg> 恢复'
    : '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 3.5v9M10.5 3.5v9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg> 暂停';
  pauseBtn.disabled = s.state === "draft";
  $("#btn-cancel").disabled = s.state === "draft";
}

/* ---------- 主 Agent 摘要 ---------- */
const BOT_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v3M5 8a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V8Z" stroke="currentColor" stroke-width="1.5" fill="none"/><circle cx="9.5" cy="12" r="1.2" fill="currentColor"/><circle cx="14.5" cy="12" r="1.2" fill="currentColor"/><path d="M12 16v3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
function renderMainAgent() {
  const s = current();
  const box = $("#agent-display");
  const ma = s.mainAgent;
  if (!ma) {
    box.innerHTML = `<div class="ma-empty">主 Agent 未启动 —— 在下方输入目标，系统会建立可编辑的目标合同并开始调度。</div>`;
    return;
  }
  const total = ma.plan.length;
  const done = ma.plan.filter((p) => p.status === "done").length;
  const cur = ma.plan.findIndex((p) => p.status === "run") + 1 || done;
  const nodes = ma.plan.map((p, i) => {
    const cls = p.status === "done" ? "done" : p.status === "run" ? "run" : "";
    const link = i < total - 1 ? `<span class="plan-link ${p.status === "done" ? "done" : ""}"></span>` : "";
    return `<span class="plan-node ${cls}"></span>${link}`;
  }).join("");
  box.innerHTML = `<button class="main-agent" id="main-agent" aria-label="主 Agent ${esc(ma.role)} 摘要，点击查看详情">
    <div class="ma-head">
      <span class="ma-avatar">${BOT_SVG}</span>
      <span class="ma-title">${esc(ma.role)}<small>主 Agent</small></span>
      <span class="chip ${MA_STATUS[ma.status] || ""}">${ma.status === "running" ? "运行中" : ma.status === "paused" ? "已暂停" : "等待中"}</span>
    </div>
    <p class="ma-obj">目标 · ${esc(ma.objective)}</p>
    <div class="ma-row ma-doing"><span class="k">正在</span><span class="v">${esc(ma.doing)}</span></div>
    <div class="ma-row ma-next"><span class="k">下一步</span><span class="v">${esc(ma.nextStep)}</span></div>
    <div class="ma-plan">
      <span class="ma-plan-label">计划</span>
      <span class="plan-track">${nodes}</span>
      <span class="plan-text">${cur}/${total} 步</span>
    </div>
    <span class="ma-more">详情 <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4.5L9.5 8 6 11.5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
  </button>`;
  $("#main-agent").addEventListener("click", () => openInspector(`${ma.role} · 主 Agent`, mainAgentDetail(ma)));
}
function mainAgentDetail(ma) {
  return `
    <div>
      <h3>目标</h3>
      <p style="font-size:12px">${esc(ma.objective)}</p>
    </div>
    <div class="insp-sec">
      <h3>计划 · ${ma.plan.filter((p) => p.status === "done").length}/${ma.plan.length}</h3>
      <ol class="plan-list">${ma.plan.map((p) => `<li class="${p.status}"><span class="p-dot"></span>${esc(p.step)}</li>`).join("")}</ol>
    </div>
    <div class="insp-sec">
      <h3>执行上下文</h3>
      <dl class="kv">
        <dt>冻结</dt><dd><span class="mono">${esc(ma.detail.frozen)}</span></dd>
        <dt>预算</dt><dd>${esc(ma.detail.budgetScope)}</dd>
        <dt>检查点</dt><dd><span class="mono">${esc(ma.detail.checkpoint)}</span></dd>
        <dt>等待</dt><dd>${esc(ma.detail.waiting)}</dd>
      </dl>
    </div>
    <p class="demo-note">steer 指令改变后续行为，不打断当前工具；暂停只能由获授权命令解除。</p>`;
}

/* ---------- 子 Agent ---------- */
function renderSubagents() {
  const s = current();
  const list = $("#subagent-list");
  if (!s.subagents.length) {
    list.innerHTML = `<div class="sa-none">无子 Agent —— 角色按任务需要启动，不做常驻聊天。</div>`;
    return;
  }
  list.innerHTML = s.subagents.map((a) => `<button class="sa-row" data-status="${a.status}" data-id="${a.id}">
    <span class="sa-ico">${esc(ROLE_SHORT[a.role] || a.role[0])}</span>
    <span class="sa-body">
      <span class="sa-name">${esc(a.role)}${a.dur ? `<span class="sa-dur">${esc(a.dur)}</span>` : ""}</span>
      <span class="sa-task">${esc(a.task)}</span>
    </span>
    <span class="sa-state">${SA_STATUS[a.status]}</span>
    <span class="sa-chevron"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4.5L9.5 8 6 11.5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
  </button>`).join("");
  $$("#subagent-list .sa-row").forEach((b) => b.addEventListener("click", () => {
    const a = s.subagents.find((x) => x.id === b.dataset.id);
    openInspector(`${a.role} · 子 Agent`, subagentDetail(a));
  }));
}
function subagentDetail(a) {
  const stLabel = SA_STATUS[a.status];
  return `
    <div>
      <div style="display:flex;align-items:center;gap:8px;margin-block-end:6px">
        <span class="sa-ico">${esc(ROLE_SHORT[a.role] || a.role[0])}</span>
        <b style="font-size:13px">${esc(a.role)}</b>
        <span class="chip ${a.status === "running" ? "chip-active" : a.status === "done" ? "" : "chip-paused"}" style="margin-inline-start:auto">${stLabel}</span>
      </div>
      <p style="font-size:12px">${esc(a.task)}</p>
    </div>
    ${a.progress ? `<div class="insp-sec"><h3>进展</h3><p style="font-size:12px;color:var(--text2)">${esc(a.progress)}</p></div>` : ""}
    <div class="insp-sec">
      <h3>执行步骤</h3>
      ${a.steps.length ? `<ol class="steps">${a.steps.map((st) => `<li class="${st.kind}"><span class="s-dot"></span><time>${st.t}</time><span class="s-text">${esc(st.text)}</span></li>`).join("")}</ol>` : `<p class="steps-empty">尚未开始执行。</p>`}
    </div>
    ${a.output ? `<div class="insp-sec"><h3>产物</h3><p class="mono" style="font-size:11px">${esc(a.output)}</p></div>` : ""}
    <p class="demo-note">子 Agent 按 RunSpec 在隔离 Worker 执行；心跳与超时由确定性服务监督，不消耗模型调用。</p>`;
}

/* ---------- 对话流 ---------- */
function renderStream() {
  const s = current();
  const box = $("#stream");
  if (!s.messages.length) {
    box.innerHTML = `<div class="empty">
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4V6Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>
      <b>从一句目标开始</b>
      <p>系统会给出可编辑的目标合同摘要；已有项目默认继承管理员设定的预算与工具范围。</p></div>`;
    return;
  }
  box.innerHTML = s.messages.map((m) => {
    if (m.role === "user") return `<div class="msg msg-user"><div class="bubble">${esc(m.text)}</div></div>`;
    const card = m.card ? `<div class="mini-card">
      <div class="mini-card-head">${esc(m.card.title)}<span class="st st-done">${esc(m.card.status)}</span></div>
      <dl>${m.card.rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl></div>` : "";
    return `<div class="msg msg-agent">
      <span class="msg-role"><span class="who">${esc(m.who)}</span>· Agent</span>
      <div class="bubble">${m.text ? esc(m.text) : ""}${card}</div></div>`;
  }).join("") + (s.state === "active" ? `<div class="msg msg-agent">
      <span class="msg-role"><span class="who">Builder</span>· Agent</span>
      <div class="bubble"><span class="typing" aria-label="正在工作"><i></i><i></i><i></i></span></div></div>` : "");
  box.scrollTop = box.scrollHeight;
}
function sendMessage(text) {
  const s = current();
  if (!text.trim() || s.state === "draft") {
    if (s.state === "draft") toast("输入目标后系统自动建立目标合同");
    return;
  }
  s.messages.push({ role: "user", text: text.trim() });
  s.messages.push({ role: "agent", who: "Coordinator", text: "已接收 steer 指令（仅改变后续行为，不打断当前工具）。下一工作单元生效。" });
  renderStream();
  toast("指令已入账（accepted），将于下一工作单元生效");
}

/* ---------- 任务状态栏 ---------- */
function renderTaskbar() {
  const s = current();
  const bar = $("#taskbar"), st = $("#taskbar-status"), mid = $("#taskbar-tasks"), bud = $("#taskbar-budget");
  bar.classList.remove("is-paused", "is-waiting");
  if (!s.work) {
    st.innerHTML = `<span style="color:var(--text3)">—</span> 未开始`;
    mid.textContent = "输入目标以建立任务";
    bud.textContent = "";
    return;
  }
  const dot = s.state === "active" ? '<span class="pulse-dot" aria-hidden="true"></span>' : "";
  st.innerHTML = dot + esc(STATE_META[s.state].label);
  if (s.state === "paused") bar.classList.add("is-paused");
  if (s.state === "waiting") bar.classList.add("is-waiting");
  const tasks = s.tasks || [];
  const done = tasks.filter((t) => t.status === "SUCCEEDED").length;
  const running = tasks.filter((t) => t.status === "RUNNING").map((t) => t.id);
  mid.textContent = tasks.length
    ? `任务 ${done}/${tasks.length}` + (running.length ? ` · ${running.join(" · ")} 运行` : "")
    : "无就绪任务 · 等待事件";
  bud.textContent = shortBudget(s.work.budgetLeft);
}
function renderTaskPop() {
  const s = current();
  const pop = $("#task-pop");
  if (!taskPopOpen || !s.work) { pop.hidden = true; return; }
  const tasks = s.tasks || [];
  pop.innerHTML = `<div class="task-pop-head">任务<span class="mono">${esc(s.goalVersion || "")}</span><span class="mono">${esc(s.work.version)}</span></div>
    <ul class="task-list">${tasks.map((t) => {
      const [cls, label] = TASK_META[t.status] || ["st-info", t.status];
      return `<li><button class="task-row-btn" style="display:flex;align-items:center;gap:9px;flex:1;min-inline-size:0;text-align:start" data-task="${t.id}">
        <span class="t-id">${t.id}</span>
        <span class="t-name">${esc(t.name)}</span>
        ${t.role ? `<span class="t-role">${esc(t.role)}</span>` : ""}
        <span class="st ${cls}" style="margin-inline-start:auto">${label}</span></button></li>`;
    }).join("") || `<li style="color:var(--text3);font-size:11px">暂无任务</li>`}</ul>
    <div style="padding:7px 12px;border-block-start:1px solid var(--line);font-size:10.5px;color:var(--text3)">等待原因 · ${esc(s.work.waitingReason)}</div>`;
  pop.hidden = false;
  $$("#task-pop [data-task]").forEach((b) => b.addEventListener("click", () => {
    const t = (s.tasks || []).find((x) => x.id === b.dataset.task);
    const [cls, label] = TASK_META[t.status] || ["st-info", t.status];
    openInspector(`任务 ${t.id}`, `<div>
        <div style="display:flex;align-items:center;gap:8px;margin-block-end:8px"><b style="font-size:13px">${esc(t.name)}</b><span class="st ${cls}" style="margin-inline-start:auto">${label}</span></div>
        <dl class="kv">
          <dt>ID</dt><dd><span class="mono">${esc(t.id)}</span></dd>
          <dt>所属目标</dt><dd><span class="mono">${esc(s.goalVersion || "—")}</span></dd>
          ${t.role ? `<dt>执行角色</dt><dd>${esc(t.role)}</dd>` : ""}
        </dl></div>
      <p class="demo-note">节点失败只重跑受影响节点及后继，保留有效前缀；图版本冻结，运行中不追随“最新”。`); 
    closeTaskPop();
  }));
}
function toggleTaskPop() {
  taskPopOpen = !taskPopOpen;
  $("#taskbar").setAttribute("aria-expanded", taskPopOpen);
  renderTaskPop();
}
function closeTaskPop() {
  taskPopOpen = false;
  $("#taskbar").setAttribute("aria-expanded", "false");
  $("#task-pop").hidden = true;
}
$("#taskbar").addEventListener("click", toggleTaskPop);
document.addEventListener("click", (e) => {
  if (taskPopOpen && !e.target.closest(".taskbar-wrap")) closeTaskPop();
});

/* ---------- 工作区：当前工作（极简） ---------- */
function renderWork() {
  const s = current();
  const panel = $("#view-work");
  if (!s.work) {
    panel.innerHTML = `<div class="empty"><b>暂无进行中的工作</b><p>输入目标后，当前工作卡会显示在这里。</p></div>`;
    return;
  }
  const w = s.work;
  panel.innerHTML = `
    <div class="sec">
      <div class="sec-head">当前工作</div>
      <dl class="kv">
        <dt>正在做</dt><dd>${esc(w.doing)}</dd>
        <dt>采用版本</dt><dd><span class="mono">${esc(w.version)}</span></dd>
        <dt>最近进展</dt><dd>${esc(w.lastProgress)}</dd>
        <dt>等待原因</dt><dd>${esc(w.waitingReason)}</dd>
        <dt>下一步</dt><dd>${esc(w.nextStep)}</dd>
      </dl>
    </div>
    <div class="sec">
      <div class="sec-head">核验进度${w.verified ? `<span class="r mono">${esc(w.verified.source)}</span>` : ""}</div>
      ${w.verified ? `<div class="verified-line">
        <span class="count">${w.verified.done}/${w.verified.total}</span>
        <div class="meter ${w.verified.done / w.verified.total > 0.8 ? "warn" : ""}"><i style="inline-size:${(w.verified.done / w.verified.total) * 100}%"></i></div>
      </div>` : `<p style="font-size:11px;color:var(--text3)">开放研究不显示整体完成百分比；按固定合同批次统计。</p>`}
    </div>
    <div class="sec">
      <div class="sec-head">资源</div>
      <dl class="kv">
        <dt>剩余额度</dt><dd>${esc(w.budgetLeft)}</dd>
      </dl>
    </div>`;
}

/* ---------- 工作区：轨迹 ---------- */
function renderTraces() {
  const s = current();
  const panel = $("#view-traces");
  if (!s.traces.length) {
    panel.innerHTML = `<div class="empty"><b>暂无轨迹</b><p>运行与 attempt 的事件轨迹将按序出现在这里，支持游标断点续传。</p></div>`;
    return;
  }
  panel.innerHTML = s.traces.map((r, i) => {
    const [cls, label] = r.status === "RUNNING" ? ["st-run", "RUNNING"]
      : r.status === "SUCCEEDED" || r.status === "COMMITTED" ? ["st-done", r.status]
      : r.status === "RECONCILE_REQUIRED" || r.status === "LOST" ? ["st-wait", r.status] : ["st-fail", r.status];
    return `<div class="trace-row ${openTrace === i ? "open" : ""}">
      <button class="trace-head" data-trace="${i}" aria-expanded="${openTrace === i}">
        <span class="trace-id">${r.id}·a${r.attempt}</span>
        <span class="st ${cls}">${label}</span>
        <span class="trace-meta">${esc(r.worker)} · ${esc(r.started)} · ${esc(r.dur)}</span>
        <span class="trace-cost">${esc(r.cost)}</span>
        <span class="trace-chev"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 6.5l3 3 3-3" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
      </button>
      ${openTrace === i ? `<div class="trace-body">
        <ol class="log">
          <li><time>14:12:03</time><span class="ev">attempt.leased</span><span>aggregate=${r.id}</span></li>
          <li><time>14:12:04</time><span class="ev">spec.frozen</span><span>${esc(s.work ? s.work.version : "")}</span></li>
          <li><time>14:12:05</time><span class="ev">tool.requested</span><span>workspace.write</span></li>
          <li><time>14:12:09</time><span class="ev">tool.allowed</span><span>gate=preflight</span></li>
          <li><time>14:14:22</time><span class="ev warn">budget.reserved</span><span>预留 +${esc(r.cost)}</span></li>
          <li><time>14:15:01</time><span class="ev">checkpoint.committed</span><span>epoch 7</span></li>
          <li><time>14:16:47</time><span class="ev">experiment.result_committed</span><span>${esc(r.id)}</span></li>
        </ol>
        <span class="log-cursor">游标 ${r.cursor} · 重连从此续传 · 按事件 ID 去重</span>
      </div>` : ""}
    </div>`;
  }).join("");
  $$("#view-traces .trace-head").forEach((b) => b.addEventListener("click", () => {
    const i = +b.dataset.trace;
    openTrace = openTrace === i ? -1 : i;
    renderTraces();
  }));
}

/* ---------- 工作区：演进与版本 ---------- */
function renderEvo() {
  const s = current();
  const panel = $("#view-evo");
  if (!s.candidates.length) {
    panel.innerHTML = `<div class="empty"><b>暂无候选</b><p>演进服务提出候选后，谱系、状态与证据在这里保留；失败与负结果不会被删除。</p></div>`;
    return;
  }
  panel.innerHTML = `<div class="sec"><div class="sec-head">候选谱系<span class="r">不可变 · 多父 · 失败保留</span></div></div>` +
    s.candidates.map((c, i) => `<div class="trace-row ${openTrace === 100 + i ? "open" : ""}">
      <button class="cand-row" data-status="${c.status}" data-cand="${i}" aria-expanded="${openTrace === 100 + i}">
        <span class="cand-main">
          <span class="cand-title"><span class="mono" style="margin-inline-end:6px">${esc(c.digest)}</span>${esc(c.title)}</span>
          <span class="cand-sub">父版本 <span class="mono">${esc(c.parent)}</span></span>
        </span>
        <span class="chip ${c.status === "RELEASED" ? "chip-active" : c.status === "CANARY" ? "chip-paused" : c.status === "REJECTED" || c.status === "ROLLED_BACK" ? "chip-blocked" : ""}">${CAND_STATUS[c.status]}</span>
        <span class="trace-chev"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 6.5l3 3 3-3" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
      </button>
      ${openTrace === 100 + i ? `<p class="cand-note">${esc(c.note)}</p>` : ""}
    </div>`).join("");
  $$("#view-evo [data-cand]").forEach((b) => b.addEventListener("click", () => {
    const i = +b.dataset.cand;
    openTrace = openTrace === 100 + i ? -1 : 100 + i;
    renderEvo();
  }));
}

/* ---------- 工作区：证据与资产 ---------- */
function renderEvidence() {
  const s = current();
  const panel = $("#view-evi");
  const e = s.evidence;
  const pill = (st) => `<span class="pill ${STANCE_PILL[st]}">`;
  const sec = (title, extra, inner) => `<div class="sec"><div class="sec-head">${title}${extra ? `<span class="r">${extra}</span>` : ""}</div>${inner}</div>`;
  if (!e.artifacts.length && !e.claims.length && !e.skills.length && !e.hypotheses.length) {
    panel.innerHTML = `<div class="empty"><b>暂无证据与资产</b><p>Artifact、Claim、技能候选与假设卡随任务运行逐步归档，全部带来源与范围。</p></div>`;
    return;
  }
  panel.innerHTML =
    sec("产物 Artifact", `${e.artifacts.length} 项`, e.artifacts.map((a, i) => `<button class="ev-row" data-kind="artifact" data-i="${i}">
      <span class="ev-name">${esc(a.name)}</span>
      <span class="ev-meta"><span class="mono">${esc(a.digest)}</span><span>${esc(a.type)}</span><span>producer ${esc(a.producer)}</span></span></button>`).join("") || `<p style="font-size:11px;color:var(--text3)">暂无</p>`) +
    sec("主张 Claim", `${e.claims.length} 项`, e.claims.map((c, i) => `<button class="ev-row" data-kind="claim" data-i="${i}">
      <span class="ev-name">${esc(c.text)}</span>
      <span class="ev-meta">${pill(c.state)}${esc(c.stance)}</span><span class="ev-meta">${esc(c.scope)}</span></button>`).join("") || `<p style="font-size:11px;color:var(--text3)">暂无</p>`) +
    sec("技能候选", e.skills.length ? `${e.skills.length} 项` : "", e.skills.map((k) => `<div class="ev-row">
      <span class="ev-name"><span class="mono">${esc(k.name)}</span> <span class="pill pill-warn">${esc(k.status)}</span></span>
      <span class="ev-meta"><span>v${esc(k.version)}</span><span>scope ${esc(k.scope)}</span><span>${esc(k.note)}</span></span></div>`).join("") || `<p style="font-size:11px;color:var(--text3)">暂无 · 新技能先为候选，需适用范围与反例</p>`) +
    sec("假设卡", e.hypotheses.length ? `${e.hypotheses.length} 项` : "", e.hypotheses.map((h) => `<div class="ev-row">
      <span class="ev-name">${esc(h.text)} <span class="pill pill-dim">${esc(h.stage)}</span></span>
      <span class="ev-meta"><span>${esc(h.verdict)}</span><span>${esc(h.scope)}</span></span></div>`).join("") || `<p style="font-size:11px;color:var(--text3)">暂无</p>`);
  $$("#view-evi [data-kind]").forEach((b) => b.addEventListener("click", () => {
    const i = +b.dataset.i;
    if (b.dataset.kind === "artifact") {
      const a = current().evidence.artifacts[i];
      openInspector(a.name, `<div>
        <h3>产物 Artifact</h3>
        <dl class="kv">
          <dt>摘要</dt><dd><span class="mono">${esc(a.digest)}</span></dd>
          <dt>类型</dt><dd>${esc(a.type)}</dd>
          <dt>生产者</dt><dd><span class="mono">${esc(a.producer)}</span></dd>
          <dt>可见范围</dt><dd>${esc(a.scope)}</dd>
        </dl></div>
        <div class="approve-actions"><button class="btn btn-primary" id="btn-dl">下载原件（权限校验后）</button></div>
        <p class="demo-note">GET /v1/artifacts/{digest}：权限检查 + 内容类型安全校验。</p>`);
      $("#btn-dl").onclick = () => toast("演示：原件下载需通过权限与内容类型校验");
    } else {
      const c = current().evidence.claims[i];
      openInspector("主张详情", `<div>
        <h3>主张 Claim</h3>
        <dl class="kv">
          <dt>陈述</dt><dd>${esc(c.text)}</dd>
          <dt>立场</dt><dd>${pill(c.state)}${esc(c.stance)}</span></dd>
          <dt>范围</dt><dd>${esc(c.scope)}</dd>
        </dl></div>
        <p class="demo-note">推论、引文与实测分开登记；报告只能引用已登记的 Claim。</p>`);
    }
  }));
}

/* ---------- 检查器 ---------- */
function openInspector(title, html) {
  $("#insp-title").textContent = title;
  $("#insp-body").innerHTML = html;
  const insp = $("#inspector");
  insp.classList.add("open");
  insp.setAttribute("aria-hidden", "false");
  insp.inert = false;
  $("#scrim-insp").hidden = false;
  $("#btn-close-insp").focus();
}
function closeInspector() {
  const insp = $("#inspector");
  insp.classList.remove("open");
  insp.setAttribute("aria-hidden", "true");
  insp.inert = true;
  $("#scrim-insp").hidden = true;
}
$("#btn-close-insp").addEventListener("click", closeInspector);
$("#scrim-insp").addEventListener("click", closeInspector);

/* ---------- 审批待办 ---------- */
function renderApprovals() {
  const s = current();
  const bar = $("#pending-bar");
  if (!s.approvals.length) { bar.hidden = true; return; }
  bar.hidden = false;
  bar.innerHTML = `<span class="st st-wait">待审批</span>
    <span><b>${esc(s.approvals[0].title)}</b></span>
    <button class="btn btn-mini" id="btn-view-ap">查看</button>`;
  $("#btn-view-ap").addEventListener("click", () => showApproval(s.approvals[0]));
}
function showApproval(ap) {
  openInspector(ap.kind, `<div>
    <h3>${esc(ap.kind)}</h3>
    <dl class="kv">
      <dt>事项</dt><dd>${esc(ap.title)}</dd>
      <dt>依据</dt><dd><span class="mono">${esc(ap.detail)}</span></dd>
      <dt>授权范围</dt><dd>${esc(ap.scope)}</dd>
    </dl></div>
    <div class="approve-actions">
      <button class="btn btn-primary" id="ap-ok">批准</button>
      <button class="btn btn-ghost" id="ap-no">拒绝</button>
    </div>
    <p class="demo-note">仅对应人工主体可在授权范围内决定；命令带 expected_version 与幂等 ID。</p>`);
  $("#ap-ok").onclick = () => decideApproval(ap, true);
  $("#ap-no").onclick = () => decideApproval(ap, false);
}
function decideApproval(ap, ok) {
  const s = current();
  s.approvals = s.approvals.filter((x) => x.id !== ap.id);
  closeInspector();
  renderApprovals();
  toast(ok ? "已批准，命令生效（applied）" : "已拒绝，已记录审计事件");
}

/* ---------- 暂停 / 恢复 / 取消 ---------- */
$("#btn-pause").addEventListener("click", () => {
  const s = current();
  if (s.state === "draft") return;
  if (s.state === "paused") {
    s.state = "active";
    if (s.mainAgent) { s.mainAgent.status = "running"; s.mainAgent.doing = "已恢复调度，继续执行下一就绪任务"; s.mainAgent.detail.waiting = "无（预算与依赖满足）"; }
    if (s.work) { s.work.waitingReason = "无（预算与依赖均满足）"; s.work.doing = "已恢复调度，继续执行下一就绪任务"; }
    s.subagents.forEach((a) => { if (a.status === "paused") a.status = "running"; });
    toast("恢复命令已生效：继续派发新任务");
  } else {
    s.state = "paused";
    if (s.mainAgent) { s.mainAgent.status = "paused"; s.mainAgent.doing = "已暂停：新任务停止派发，当前有界动作排空或终止"; s.mainAgent.detail.waiting = "PAUSED_USER：只能由获授权命令解除"; }
    if (s.work) { s.work.waitingReason = "PAUSED_USER：已停止派发新任务；当前动作按策略排空或终止（1/2 已完成）"; s.work.doing = "暂停中：等待当前有界动作排空，不强制中断工具"; }
    s.subagents.forEach((a) => { if (a.status === "running") a.status = "paused"; });
    toast("暂停命令已入账（accepted）→ 已生效（applied）：新任务停止派发");
  }
  closeTaskPop();
  renderAll();
});
$("#btn-cancel").addEventListener("click", () => $("#dlg-confirm").showModal());
$("#btn-confirm-cancel").addEventListener("click", () => {
  const s = current();
  s.state = "cancelled";
  if (s.mainAgent) { s.mainAgent.status = "paused"; s.mainAgent.doing = "目标已取消"; }
  if (s.work) { s.work.doing = "目标已取消"; s.work.waitingReason = "CANCELLED：历史、证据与审计记录保留可查询"; }
  s.subagents.forEach((a) => { if (a.status === "running" || a.status === "paused") a.status = "failed"; });
  $("#dlg-confirm").close();
  closeTaskPop();
  renderAll();
  toast("目标已取消；未结算费用保留记录");
});

/* ---------- 断线 / 游标恢复演示 ---------- */
let reconnectTimer;
function simulateReconnect() {
  const conn = $("#conn"), banner = $("#reconnect");
  conn.classList.add("down");
  $(".conn-text").textContent = "重连中…";
  $("#reconnect-text").textContent = `连接中断，正在从游标 ${cursor} 恢复事件流…`;
  banner.hidden = false;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    banner.hidden = true;
    conn.classList.remove("down");
    $(".conn-text").textContent = cursor;
    toast(`已从游标 ${cursor} 恢复，丢失事件由数据库补齐，无重复消息`);
  }, 2400);
}
$("#conn").addEventListener("click", simulateReconnect);

/* ---------- 输入区 ---------- */
$("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("#composer-input");
  sendMessage(input.value);
  input.value = ""; input.style.blockSize = "auto";
});
$("#composer-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("#composer").requestSubmit(); }
});
$("#composer-input").addEventListener("input", function () {
  this.style.blockSize = "auto";
  this.style.blockSize = Math.min(this.scrollHeight, 130) + "px";
});
$$(".chip-btn[data-steer]").forEach((b) => b.addEventListener("click", () => {
  const input = $("#composer-input");
  input.value = b.dataset.steer; input.focus();
}));
$("#chip-expand-budget").addEventListener("click", () => toast("演示：预算修订产生新目标版本，并标注哪些后继任务需重算"));

/* ---------- 视图切换 ---------- */
const tabs = $$(".wv-tabs [role='tab']");
function selectTab(tab) {
  tabs.forEach((t) => {
    const on = t === tab;
    t.setAttribute("aria-selected", on);
    t.tabIndex = on ? 0 : -1;
    $("#" + t.getAttribute("aria-controls")).hidden = !on;
  });
  closeTaskPop();
}
tabs.forEach((t, i) => {
  t.addEventListener("click", () => selectTab(t));
  t.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") { selectTab(tabs[(i + 1) % tabs.length]); tabs[(i + 1) % tabs.length].focus(); }
    if (e.key === "ArrowLeft") { selectTab(tabs[(i - 1 + tabs.length) % tabs.length]); tabs[(i - 1 + tabs.length) % tabs.length].focus(); }
  });
});

/* ---------- 侧栏抽屉 ---------- */
function openSidebarDrawer() { const sb = $("#sidebar"); sb.classList.add("open"); sb.inert = false; $("#scrim-sidebar").hidden = false; $("#btn-menu").setAttribute("aria-expanded", "true"); }
function closeSidebarDrawer() { const sb = $("#sidebar"); sb.classList.remove("open"); sb.inert = true; $("#scrim-sidebar").hidden = true; $("#btn-menu").setAttribute("aria-expanded", "false"); }
$("#btn-menu").addEventListener("click", openSidebarDrawer);
$("#scrim-sidebar").addEventListener("click", closeSidebarDrawer);

/* ---------- 新建会话 ---------- */
$("#btn-new-session").addEventListener("click", () => {
  const id = "ses_" + Math.random().toString(36).slice(2, 6);
  sessions.unshift({ id, project: "harness-improvement", title: "新会话", state: "draft", updatedAt: "刚刚", goalVersion: null, mainAgent: null, subagents: [], work: null, tasks: [], traces: [], messages: [], candidates: [], evidence: { artifacts: [], claims: [], skills: [], hypotheses: [] }, approvals: [] });
  currentId = id;
  renderAll();
  $("#composer-input").focus();
});

/* ---------- 主题 ---------- */
const resolvedTheme = () =>
  document.documentElement.dataset.theme ||
  (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
$("#btn-theme").addEventListener("click", () => {
  const next = resolvedTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("looplab-theme", next); } catch (e) {}
  toast(next === "dark" ? "已切换到深色外观" : "已切换到浅色外观");
});

/* ---------- 设置 / 对话框 ---------- */
$("#btn-settings").addEventListener("click", () => $("#dlg-settings").showModal());
$$("dialog [data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));

/* ---------- 键盘 ---------- */
document.addEventListener("keydown", (e) => {
  if (e.target.matches("textarea, input") || e.target.closest("dialog")) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === "?") $("#dlg-help").showModal();
  else if (k === "p") $("#btn-pause").click();
  else if (k === "n") $("#btn-new-session").click();
  else if (k === "t") toggleTaskPop();
  else if (k === "1") selectTab(tabs[0]);
  else if (k === "2") selectTab(tabs[1]);
  else if (k === "3") selectTab(tabs[2]);
  else if (k === "4") selectTab(tabs[3]);
  else if (e.key === "Escape") {
    if ($("#inspector").classList.contains("open")) closeInspector();
    else if (taskPopOpen) closeTaskPop();
  }
});

/* ---------- 渲染入口 ---------- */
function renderAll() {
  renderSessions();
  renderTopbar();
  renderMainAgent();
  renderSubagents();
  renderStream();
  renderTaskbar();
  renderTaskPop();
  renderWork();
  renderTraces();
  renderEvo();
  renderEvidence();
  renderApprovals();
}
$("#inspector").inert = true;
const syncDrawerInert = () => {
  const drawerMode = matchMedia("(max-width: 1240px)").matches;
  $("#sidebar").inert = drawerMode && !$("#sidebar").classList.contains("open");
};
syncDrawerInert();
matchMedia("(max-width: 1240px)").addEventListener("change", syncDrawerInert);
renderAll();
