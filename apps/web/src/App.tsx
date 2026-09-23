import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Attempt, type Candidate, type Message, type Project, type Session, type Task, type WorkCard } from "./api";
import { useEventStream } from "./useEventStream";
import { Workspace, Inspector } from "./Workspace";

type ViewTab = "work" | "runs" | "evolution" | "evidence";

export function App() {
  const [user, setUser] = useState<{ username: string; role: string } | null>(null);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [authError, setAuthError] = useState<string | null>(null);

  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSession, setActiveSession] = useState<string | null>(null);

  const [messages, setMessages] = useState<Message[]>([]);
  const [activeGoal, setActiveGoal] = useState<string | null>(null);
  const [card, setCard] = useState<WorkCard | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [taskBarOpen, setTaskBarOpen] = useState(false);
  const [view, setView] = useState<ViewTab>("work");
  const [inspector, setInspector] = useState<{ kind: string; id: string } | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const goalId = card?.goal_id ?? null;
  const stream = useEventStream(goalId);

  const refreshMeta = useCallback(async () => {
    if (!user) return;
    const ps = await api.projects();
    setProjects(ps.projects);
    setActiveProject((cur) => cur ?? ps.projects[0]?.id ?? null);
  }, [user]);

  useEffect(() => { refreshMeta(); }, [refreshMeta]);

  useEffect(() => {
    if (!user || !activeProject) return;
    api.sessions(activeProject).then((r) => setSessions(r.sessions)).catch(() => {});
  }, [user, activeProject]);

  const loadSession = useCallback(async (sid: string) => {
    setActiveSession(sid);
    setActiveGoal(null);
    const r = await api.messages(sid);
    setMessages(r.messages);
    setView("work");
    setInspector(null);
  }, []);

  useEffect(() => {
    if (!activeSession) return;
    api.messages(activeSession).then((r) => setMessages(r.messages)).catch(() => {});
  }, [activeSession]);

  const refreshGoal = useCallback(async () => {
    const sid = activeSession;
    if (!sid) return;
    const s = sessions.find((x) => x.id === sid);
    const gid = activeGoal ?? s?.goal_id ?? null;
    if (!gid) { setCard(null); setTasks([]); setAttempts([]); setCandidates([]); return; }
    try {
      setCard(await api.goal(gid));
      setTasks((await api.tasks(gid)).tasks);
      setAttempts((await api.attempts(gid)).attempts);
      setCandidates((await api.candidates(gid)).candidates);
    } catch { /* goal may be gone */ }
  }, [activeSession, sessions, activeGoal]);

  useEffect(() => { refreshGoal(); }, [refreshGoal]);
  useEffect(() => {
    if (!stream.events.length) return;
    const t = setTimeout(() => refreshGoal(), 300);
    return () => clearTimeout(t);
  }, [stream.events, refreshGoal]);

  const newSession = useCallback(async () => {
    if (!activeProject) return;
    const r = await api.createSession(activeProject, "新会话");
    const list = await api.sessions(activeProject);
    setSessions(list.sessions);
    await loadSession(r.id);
  }, [activeProject, loadSession]);

  const send = useCallback(async (text?: string) => {
    const content = (text ?? input).trim();
    if (!content || !activeSession || sending) return;
    setSending(true);
    setInput("");
    try {
      const resp = await api.sendMessage(activeSession, content);
      if (resp?.goal_id) setActiveGoal(resp.goal_id);
      if (activeProject) api.sessions(activeProject).then((r) => setSessions(r.sessions)).catch(() => {});
      const r = await api.messages(activeSession);
      setMessages(r.messages);
      await refreshGoal();
    } catch (e) {
      setLastErrorMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }, [input, activeSession, sending, refreshGoal, activeProject]);

  const [lastErrorMsg, setLastErrorMsg] = useState<string | null>(null);

  const pauseResume = useCallback(async () => {
    if (!goalId || !card) return;
    const kind = card.state === "PAUSED_USER" ? "resume" : "pause";
    await api.command(goalId, kind);
    await refreshGoal();
  }, [goalId, card, refreshGoal]);

  const doCancel = useCallback(async () => {
    if (!goalId) return;
    await api.command(goalId, "cancel");
    setConfirmCancel(false);
    await refreshGoal();
  }, [goalId, refreshGoal]);

  // keyboard shortcuts (design §16.4 / front-design README)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inField = (e.target as HTMLElement)?.tagName === "TEXTAREA" || (e.target as HTMLElement)?.tagName === "INPUT";
      if (e.key === "Escape") { setInspector(null); setConfirmCancel(false); setTaskBarOpen(false); return; }
      if (inField) return;
      if (!user) return;
      if (e.key >= "1" && e.key <= "4") setView((["work", "runs", "evolution", "evidence"] as ViewTab[])[Number(e.key) - 1]);
      if (e.key === "t" || e.key === "T") setTaskBarOpen((v) => !v);
      if (e.key === "p" || e.key === "P") pauseResume();
      if (e.key === "n" || e.key === "N") newSession();
      if (e.key === "?") setTaskBarOpen((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [user, pauseResume, newSession]);

  const pendingApprovals = useMemo(
    () => stream.events.filter((e) => e.event_type === "approval.requested").slice(-3),
    [stream.events],
  );

  if (!user) {
    return (
      <div className="auth-wrap">
        <form className="auth-card" onSubmit={async (e) => {
          e.preventDefault();
          setAuthError(null);
          const fd = new FormData(e.currentTarget);
          const username = String(fd.get("username")), password = String(fd.get("password"));
          try {
            if (authMode === "register") await api.register(username, password);
            else await api.login(username, password);
            setUser((await api.me()).user);
          } catch (err: any) { setAuthError(err.body?.error ?? err.message); }
        }}>
          <h1>LoopLab 工作台</h1>
          <p className="muted">自我改进 Agent 框架 · 本地控制服务</p>
          <label>用户名<input name="username" autoComplete="username" required /></label>
          <label>密码<input name="password" type="password" autoComplete="current-password" required /></label>
          {authError && <div className="err">{authError}</div>}
          <button type="submit">{authMode === "login" ? "登录" : "注册（首个用户为管理员）"}</button>
          <button type="button" className="ghost" onClick={() => setAuthMode(authMode === "login" ? "register" : "login")}>
            {authMode === "login" ? "没有账号？注册" : "已有账号？登录"}
          </button>
        </form>
      </div>
    );
  }

  const stateClass = card ? card.state.toLowerCase() : "";
  const runningAttempts = attempts.filter((a) => ["LEASED", "STARTED", "RUNNING", "RESULT_PENDING"].includes(a.status));

  return (
    <div className="app">
      <header className="topbar" role="banner">
        <div className="topbar-goal">
          <span className="brand">LoopLab</span>
          {card ? (
            <>
              <span className={`state-chip ${stateClass}`}>{card.state}</span>
              <span className="goal-title" title={card.objective}>{card.objective}</span>
            </>
          ) : <span className="muted">未选择目标</span>}
        </div>
        <div className="topbar-actions">
          {card && (
            <span className="budget mono" title={`已用 $${card.budget.used} + 未结算 $${card.budget.unknown} / 上限 $${card.budget.cap}`}>
              ${card.budget.used.toFixed(3)}{card.budget.unknown > 0 ? `(+${card.budget.unknown.toFixed(3)}?)` : ""} / ${card.budget.cap}
            </span>
          )}
          {card && <button onClick={pauseResume}>{card.state === "PAUSED_USER" ? "恢复 (P)" : "暂停 (P)"}</button>}
          {card && <button className="danger" onClick={() => setConfirmCancel(true)}>取消</button>}
          <span className={`conn ${stream.connected ? "on" : "off"}`} title={stream.lastError ?? ""}>
            {stream.connected ? "已连接" : stream.resuming ? "按游标恢复…" : "断开"}
          </span>
          <button className="ghost" onClick={async () => { await api.logout(); setUser(null); }}>退出</button>
        </div>
      </header>

      <div className="main">
        <aside className="sidebar" aria-label="项目与会话">
          <div className="side-eyebrow">项目</div>
          {projects.map((p) => (
            <button key={p.id} className={`side-item ${p.id === activeProject ? "active" : ""}`} onClick={() => { setActiveProject(p.id); setActiveSession(null); }}>
              {p.name}
            </button>
          ))}
          <div className="side-eyebrow">会话 <button className="mini" onClick={newSession}>+ 新建 (N)</button></div>
          <div className="session-list">
            {sessions.length === 0 && <div className="empty">暂无会话</div>}
            {sessions.map((s) => (
              <button key={s.id} className={`side-item ${s.id === activeSession ? "active" : ""}`} onClick={() => loadSession(s.id)}>
                <span className="dot" data-state={(s as any).goal_state ?? "none"} />{s.title}
              </button>
            ))}
          </div>
        </aside>

        <section className="agent-area" aria-label="Agent 区">
          {card && <SummaryCard card={card} onOpen={() => setInspector({ kind: "goal", id: card.goal_id })} />}

          {runningAttempts.length > 0 && (
            <div className="subagents" aria-label="子 Agent">
              {runningAttempts.map((a) => (
                <button key={a.id} className="subagent-row" onClick={() => setInspector({ kind: "attempt", id: a.id })}>
                  <span className="role-badge">{a.role}</span>
                  <span className="sa-title">{a.task_title}</span>
                  <span className="mono muted">{a.model_calls} calls · {a.worker_id}</span>
                  <span className="pulse" aria-label="运行中" />
                </button>
              ))}
            </div>
          )}

          <div className="chat" role="log" aria-live="polite">
            {messages.length === 0 && <div className="empty">发送目标后，Coordinator 会规划任务图并开始执行。</div>}
            {messages.map((m) => (
              <div key={m.id} className={`msg ${m.role}`}>
                <div className="msg-content">{m.content}</div>
              </div>
            ))}
            {stream.events.filter((e) => e.event_type === "model.call_started").length > 0 && sending === false && runningAttempts.length > 0 && (
              <div className="typing mono">agent 运行中 · 模型调用 {runningAttempts.reduce((a, b) => a + b.model_calls, 0)} 次</div>
            )}
          </div>

          {pendingApprovals.length > 0 && (
            <div className="approval-strip">有待审批事项（见检查器）</div>
          )}

          <div className={`taskbar mono ${taskBarOpen ? "open" : ""}`} onClick={() => setTaskBarOpen((v) => !v)} role="button" tabIndex={0}>
            {card ? (
              <>状态 {card.state} · 任务 {card.verified ? `${card.verified.done}/${card.verified.total}` : "—"} ·
                运行 {runningAttempts.length} · 预算 ${card.budget.used.toFixed(3)}{card.budget.unknown > 0 ? `+未结算$${card.budget.unknown.toFixed(3)}` : ""}{card.waiting_reason ? ` · 等待:${card.waiting_reason}` : ""} <span className="caret">⌄</span></>
            ) : "任务状态栏 (T)"}
          </div>
          {taskBarOpen && (
            <div className="tasklist">
              {tasks.length === 0 && <div className="empty">无任务</div>}
              {tasks.map((t) => (
                <div key={t.id} className="task-row">
                  <span className="dot" data-state={t.state} /> <span className="role-badge">{t.role}</span>
                  <span className="task-title">{t.title}</span>
                  <span className="mono muted">{t.state}{t.failure_count > 0 ? ` · 失败${t.failure_count}次` : ""}</span>
                </div>
              ))}
            </div>
          )}

          <form className="inputbar" onSubmit={(e) => { e.preventDefault(); send(); }}>
            <textarea
              value={input}
              disabled={!activeSession}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder={activeSession ? (card ? "实时输入：steer 会在下一轮生效，不打断当前工具 (Shift+Enter 换行)" : "描述你的目标…") : "先新建会话…"}
              rows={2}
            />
            <div className="chips">
              <button type="button" className="chip" onClick={() => send("请总结当前进展与下一步")}>总结进展</button>
              <button type="button" className="chip" onClick={() => send("跳过当前分支，改走替代路线")}>换路线</button>
              <button type="submit" disabled={sending || !input.trim()}>发送 ⏎</button>
            </div>
          </form>
        </section>

        <section className="workspace" aria-label="工作区">
          <nav className="tabs" role="tablist" aria-label="工作区视图">
            {([["work", "当前工作"], ["runs", "运行记录"], ["evolution", "演进与版本"], ["evidence", "证据与资产"]] as const).map(([k, label], i) => (
              <button key={k} role="tab" aria-selected={view === k} className={`tab ${view === k ? "active" : ""}`} onClick={() => setView(k)}>
                {label} <kbd>{i + 1}</kbd>
              </button>
            ))}
          </nav>
          <Workspace
            view={view} card={card} tasks={tasks} attempts={attempts}
            candidates={candidates} goalId={goalId} stream={stream}
            onOpenInspector={setInspector}
          />
        </section>
      </div>

      {inspector && (
        <Inspector
          spec={inspector} onClose={() => setInspector(null)}
          card={card} attempts={attempts} tasks={tasks} goalId={goalId} candidates={candidates}
        />
      )}

      {confirmCancel && card && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="确认取消">
          <div className="modal">
            <h3>取消目标？</h3>
            <p>将停止派发并请求中止正在运行的动作。</p>
            <p className="warn">已经发生的外部副作用（已写文件、已运行实验、已调用模型）不会被撤销。</p>
            <div className="modal-actions">
              <button className="ghost" onClick={() => setConfirmCancel(false)}>返回 (Esc)</button>
              <button className="danger" onClick={doCancel}>确认取消</button>
            </div>
          </div>
        </div>
      )}
      {lastErrorMsg && <div className="toast err" onClick={() => setLastErrorMsg(null)}>{lastErrorMsg}</div>}
    </div>
  );
}

function SummaryCard({ card, onOpen }: { card: WorkCard; onOpen: () => void }) {
  return (
    <button className="summary-card" onClick={onOpen} title="打开检查器查看完整计划与预算分账">
      <div className="sc-row sc-head">
        <span className="role-badge">Coordinator</span>
        <span className="mono muted">{card.graph_version ?? "无图"}</span>
        {card.waiting_reason && <span className="state-chip waiting">{card.waiting_reason}</span>}
      </div>
      <div className="sc-grid">
        <div><span className="eyebrow">正在做</span>{card.doing ?? (card.state === "PAUSED_USER" ? "已暂停" : "空闲")}</div>
        <div><span className="eyebrow">最近有效进展</span>{card.last_progress ?? "—"}</div>
        <div><span className="eyebrow">下一步</span>{card.next_step ?? "—"}</div>
        <div>
          <span className="eyebrow">核验</span>
          {card.verified ? `${card.verified.done}/${card.verified.total}（固定合同批次）` : "开放研究：不显示整体百分比"}
        </div>
      </div>
    </button>
  );
}
