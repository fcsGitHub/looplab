import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Attempt, type Candidate, type Message, type PlatformEvent, type Project, type Session, type Task, type WorkCard, type WorkerRow, type GoalListRow, type ApprovalRow } from "./api";
import { useEventStream } from "./useEventStream";
import { Workspace, Inspector } from "./Workspace";
import { mergeTimeline, milestoneView, TONE_GLYPH } from "./chat";

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
  const [showSys, setShowSys] = useState(false);
  const [goalOverview, setGoalOverview] = useState<GoalListRow[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    localStorage.getItem("looplab-theme") === "light" ? "light" : "dark",
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("looplab-theme", theme);
  }, [theme]);

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

  const [lastErrorMsg, setLastErrorMsg] = useState<string | null>(null);

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

  // approvals + goal overview refresh whenever the stream moves or the view opens
  const refreshSidebars = useCallback(async () => {
    if (!user) return;
    api.approvals().then((r) => setApprovals(r.approvals)).catch(() => {});
    api.goalsList().then((r) => setGoalOverview(r.goals)).catch(() => {});
  }, [user]);
  useEffect(() => { refreshSidebars(); }, [refreshSidebars]);
  useEffect(() => {
    if (stream.events.length) refreshSidebars();
  }, [stream.events.length, refreshSidebars]);
  useEffect(() => {
    if (!user) return;
    const t = setInterval(() => refreshSidebars(), 20_000);
    return () => clearInterval(t);
  }, [user, refreshSidebars]);

  const decideApproval = useCallback(async (id: string, decision: "approve" | "reject") => {
    try {
      await api.approvalDecision(id, decision);
      await refreshSidebars();
      await refreshGoal();
    } catch (e) {
      setLastErrorMsg(e instanceof Error ? e.message : String(e));
    }
  }, [refreshSidebars, refreshGoal]);

  // 对话流 = 用户消息（DB）+ Agent 里程碑（SSE 事件派生），按时间合并
  const timeline = useMemo(() => mergeTimeline(messages, stream.events), [messages, stream.events]);

  // 审批卡状态：PENDING 来自 /v1/approvals（该列表只含未裁决行，V20），
  // 裁决状态来自真实账本事件 approval.granted/rejected（随目标流回放）。
  const approvalStatus = useMemo(() => {
    const m = new Map(approvals.map((a) => [a.id, a.status]));
    for (const e of stream.events) {
      if (e.event_type === "approval.granted") m.set(e.aggregate_id, "APPROVED");
      else if (e.event_type === "approval.rejected") m.set(e.aggregate_id, "REJECTED");
    }
    return m;
  }, [approvals, stream.events]);

  // 当前目标调度优先级（1 最急 .. 9 最不急）——来自 /v1/goals 列表真实行
  const currentPriority = useMemo(
    () => goalOverview.find((g) => g.id === goalId)?.priority ?? null,
    [goalOverview, goalId],
  );
  const changePriority = useCallback(async (p: number) => {
    if (!goalId) return;
    try {
      await api.command(goalId, "set_priority", { priority: p });
      await refreshSidebars();
    } catch (e) {
      setLastErrorMsg(e instanceof Error ? e.message : String(e));
    }
  }, [goalId, refreshSidebars]);

  // 聊天跟随滚动：用户上滑即暂停跟随，回到底部自动恢复
  const chatRef = useRef<HTMLDivElement>(null);
  const chatStick = useRef(true);
  const timelineLen = timeline.length;
  useEffect(() => {
    const el = chatRef.current;
    if (el && chatStick.current) el.scrollTop = el.scrollHeight;
  }, [timelineLen]);
  const onChatScroll = useCallback(() => {
    const el = chatRef.current;
    if (el) chatStick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 56;
  }, []);

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
          <span className="brand">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 1.5a6.5 6.5 0 1 0 6.5 6.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
              <path d="M14.5 4.5v3h-3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" transform="translate(0.3 0.8) scale(0.85)"/>
              <circle cx="8" cy="8" r="2" fill="currentColor"/>
            </svg>
            LoopLab
          </span>
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
          {card && (
            <label className="priority-sel" title="调度优先级：1 最急 .. 9 最不急（抢占更早的积压，同级 FIFO）">
              <span className="muted small">优先级</span>
              <select
                value={currentPriority ?? 5}
                onChange={(e) => changePriority(Number(e.target.value))}
              >
                {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
          )}
          {card && <button onClick={pauseResume}>{card.state === "PAUSED_USER" ? "恢复 (P)" : "暂停 (P)"}</button>}
          {card && <button className="danger" onClick={() => setConfirmCancel(true)}>取消</button>}
          <span className={`conn ${stream.connected ? "on" : "off"}`} title={stream.lastError ?? ""}>
            {stream.connected ? "已连接" : stream.resuming ? "按游标恢复…" : "断开"}
          </span>
          <button
            className="ghost theme-toggle"
            onClick={() => setShowSys(true)}
            title="系统：模型配置与服务指标"
            aria-label="系统设置与指标"
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="8" cy="8" r="2.2" stroke="currentColor" strokeWidth="1.4"/>
              <path d="M8 1.8l.7 1.8a4.6 4.6 0 0 1 1.6.7l1.9-.6 1.4 2.4-1.2 1.5c.05.26.05.53 0 .8l1.2 1.5-1.4 2.4-1.9-.6a4.6 4.6 0 0 1-1.6.7L8 14.2l-.7-1.8a4.6 4.6 0 0 1-1.6-.7l-1.9.6-1.4-2.4 1.2-1.5a4.7 4.7 0 0 1 0-.8L2.4 6.1l1.4-2.4 1.9.6a4.6 4.6 0 0 1 1.6-.7L8 1.8Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
            </svg>
          </button>
          <button
            className="ghost theme-toggle"
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            title={theme === "dark" ? "切换为亮色主题" : "切换为暗色主题"}
            aria-label="切换主题"
          >
            {theme === "dark" ? (
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <circle cx="8" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.5"/>
                <path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M13.5 9.5A6 6 0 0 1 6.5 2.5a6 6 0 1 0 7 7Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
              </svg>
            )}
          </button>
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
          <div className="side-eyebrow">进行中目标 <button className="mini" onClick={refreshSidebars}>刷新</button></div>
          <div className="session-list">
            {goalOverview.filter((g) => !["COMPLETED", "CANCELLED", "FAILED"].includes(g.state)).length === 0 && (
              <div className="empty">暂无进行中的目标</div>
            )}
            {goalOverview
              .filter((g) => !["COMPLETED", "CANCELLED", "FAILED"].includes(g.state))
              .slice(0, 12)
              .map((g) => (
                <button
                  key={g.id}
                  className={`side-item ${g.id === activeGoal ? "active" : ""}`}
                  title={`${g.state} · ${g.task_count} 任务 · ${g.updated_at.slice(0, 16).replace("T", " ")}`}
                  onClick={() => {
                    setActiveProject((cur) => (cur === g.project_id ? cur : g.project_id));
                    setActiveGoal(g.id);
                    if (g.session_id) loadSession(g.session_id);
                  }}
                >
                  <span className="dot" data-state={g.state} />
                  <span className="side-goal-title">{g.title}</span>
                  <span className="mono muted small" title={`调度优先级 ${g.priority}`}>P{g.priority}</span>
                  <span className="mono muted small">{g.state.slice(0, 6)}</span>
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
                  <span className="role-badge" data-role={a.role}>{a.role}</span>
                  <span className="sa-title">{a.task_title}</span>
                  <span className="mono muted">{a.model_calls} calls · {a.worker_id}</span>
                  <span className="pulse" aria-label="运行中" />
                </button>
              ))}
            </div>
          )}

          <div className="chat" role="log" aria-live="polite" ref={chatRef} onScroll={onChatScroll}>
            {timeline.length === 0 && <div className="empty">发送目标后，Coordinator 会规划任务图并开始执行。</div>}
            {timeline.map((entry) =>
              entry.kind === "user" ? (
                <div key={entry.id} className={`msg ${entry.role === "user" ? "user" : "agent"}`}>
                  <div className="msg-meta">
                    {entry.role === "user" ? "你" : "LoopLab"} · {new Date(entry.at).toLocaleTimeString("zh-CN", { hour12: false })}
                  </div>
                  <div className="msg-content">{entry.text}</div>
                </div>
              ) : (
                <ChatMilestone
                  key={entry.id}
                  event={entry.event}
                  onOpenInspector={setInspector}
                  approvalStatus={approvalStatus}
                  onDecideApproval={decideApproval}
                />
              ),
            )}
            {stream.events.filter((e) => e.event_type === "model.call_started").length > 0 && sending === false && runningAttempts.length > 0 && (
              <div className="typing mono">agent 运行中 · 模型调用 {runningAttempts.reduce((a, b) => a + b.model_calls, 0)} 次</div>
            )}
          </div>

          {approvals.length > 0 && (
            <div className="approval-strip">
              {approvals.slice(0, 3).map((a) => (
                <span key={a.id} className="approval-item">
                  待审批 · {a.title.length > 42 ? `${a.title.slice(0, 42)}…` : a.title}
                  <button onClick={() => decideApproval(a.id, "approve")} title="批准并自动执行后续动作">批准</button>
                  <button className="ghost" onClick={() => decideApproval(a.id, "reject")}>驳回</button>
                </span>
              ))}
              {approvals.length > 3 && <span className="muted small">…共 {approvals.length} 项</span>}
            </div>
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
                  <span className="dot" data-state={t.state} /> <span className="role-badge" data-role={t.role}>{t.role}</span>
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
            onOpenInspector={setInspector} userRole={user.role}
          />
        </section>
      </div>

      {inspector && (
        <Inspector
          spec={inspector} onClose={() => setInspector(null)}
          card={card} attempts={attempts} tasks={tasks} goalId={goalId} candidates={candidates}
          onOpenInspector={setInspector}
        />
      )}

      {showSys && <SystemModal onClose={() => setShowSys(false)} />}
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

function ChatMilestone({ event, onOpenInspector, approvalStatus, onDecideApproval }: {
  event: PlatformEvent;
  onOpenInspector: (s: { kind: string; id: string }) => void;
  approvalStatus?: Map<string, string>;
  onDecideApproval?: (id: string, decision: "approve" | "reject") => void;
}) {
  const v = milestoneView(event);
  if (!v) return null;
  const inspector = event.event_type === "evaluation.completed" && event.payload?.candidate_id
    ? { kind: "candidate", id: String(event.payload.candidate_id) }
    : v.inspector;
  // 审批卡：PENDING 时内联批准/驳回，已裁决后显示真实状态
  const approvalId = event.event_type === "approval.requested"
    ? String(event.payload?.approval_id ?? "") : "";
  const approvalState = approvalId ? approvalStatus?.get(approvalId) ?? "PENDING" : null;
  return (
    <div className="msg agent">
      <div className="msg-meta">LoopLab · {new Date(event.occurred_at).toLocaleTimeString("zh-CN", { hour12: false })}</div>
      <button
        className={`data-card ${v.tone} ${inspector ? "link" : ""}`}
        onClick={inspector ? () => onOpenInspector(inspector) : undefined}
        disabled={!inspector}
        title={inspector ? "打开检查器详情" : undefined}
      >
        <span className="dc-glyph" aria-hidden="true">{TONE_GLYPH[v.tone]}</span>
        <span className="dc-main">
          <span className="dc-head">{v.head}{v.meta && <span className="dc-meta mono"> · {v.meta}</span>}</span>
          {v.lines.map((l, i) => <span key={i} className="dc-line">{l}</span>)}
        </span>
      </button>
      {approvalId && approvalState === "PENDING" && onDecideApproval && (
        <div className="ms-approval-actions">
          <button onClick={() => onDecideApproval(approvalId, "approve")}>批准重规划</button>
          <button className="ghost" onClick={() => onDecideApproval(approvalId, "reject")}>驳回</button>
        </div>
      )}
      {approvalId && approvalState && approvalState !== "PENDING" && (
        <div className="ms-approval-done mono small">{approvalState === "APPROVED" ? "已批准" : "已驳回"}</div>
      )}
    </div>
  );
}

function SystemModal({ onClose }: { onClose: () => void }) {
  const [model, setModel] = useState<any>(null);
  const [metrics, setMetrics] = useState<any>(null);
  const [workers, setWorkers] = useState<WorkerRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  useEffect(() => {
    api.settingsModel().then(setModel).catch((e) => setErr(String(e?.message ?? e)));
    api.metrics().then(setMetrics).catch(() => {});
    api.workers().then((r) => setWorkers(r.workers)).catch(() => setWorkers([]));
  }, []);
  const fmtUptime = (s: number) => {
    const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m ${Math.floor(s % 60)}s`;
  };
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="系统" onClick={onClose}>
      <div className="modal sys-modal" onClick={(e) => e.stopPropagation()}>
        <h3>系统</h3>
        {err && <div className="err small">{err}</div>}
        <div className="eyebrow">模型配置（密钥不出控制进程）</div>
        {model ? (
          <div className="sys-grid">
            {"provider" in (model ?? {}) && <div><span className="eyebrow">Provider</span>{String(model.provider)}</div>}
            {"model" in (model ?? {}) && <div><span className="eyebrow">Model</span><span className="mono">{String(model.model)}</span></div>}
            {(model as any).models && (model as any).models.map((m: any, i: number) => (
              <div key={i}><span className="eyebrow">{String(m.kind ?? m.scope ?? `model ${i + 1}`)}</span><span className="mono">{String(m.model ?? m.name ?? JSON.stringify(m))}</span></div>
            ))}
            {"key_fingerprint" in (model ?? {}) && <div><span className="eyebrow">密钥指纹</span><span className="mono">{String(model.key_fingerprint)}</span></div>}
            {!("provider" in model) && !("models" in model) && <div className="mono small" style={{ gridColumn: "1/-1" }}>{JSON.stringify(model)}</div>}
          </div>
        ) : <div className="empty">加载中…</div>}
        <div className="eyebrow">服务指标</div>
        {metrics ? (
          <div className="sys-grid">
            <div><span className="eyebrow">运行时长</span>{fmtUptime(Number(metrics.uptime_s) || 0)}</div>
            <div>
              <span className="eyebrow">模型调用</span>
              <span className="num">
                {metrics.model?.calls ?? 0} 次 · ${Number(metrics.model?.cost_usd ?? 0).toFixed(4)}
                {metrics.model?.daily_cap_usd
                  ? ` · 24h $${Number(metrics.model?.last_24h_usd ?? 0).toFixed(3)}/$${Number(metrics.model.daily_cap_usd).toFixed(2)}`
                  : ""}
              </span>
            </div>
            <div><span className="eyebrow">事件</span><span className="num">{metrics.events?.count ?? 0}</span></div>
            <div>
              <span className="eyebrow">目标</span>
              <span className="num">{(metrics.goals ?? []).map((g: any) => `${g.state}:${g.n}`).join("  ") || "—"}</span>
            </div>
            <div>
              <span className="eyebrow">Attempts</span>
              <span className="num">{(metrics.attempts ?? []).map((a: any) => `${a.status}:${a.n}`).join("  ") || "—"}</span>
            </div>
            <div>
              <span className="eyebrow">编排器</span>
              <span className="mono small">{metrics.orchestrator?.last_reconcile_at ? new Date(metrics.orchestrator.last_reconcile_at).toLocaleTimeString("zh-CN", { hour12: false }) : "—"}{metrics.orchestrator?.last_error ? ` · ${metrics.orchestrator.last_error}` : ""}</span>
            </div>
          </div>
        ) : <div className="empty">加载中…</div>}
        <div className="eyebrow">Worker 集群</div>
        {workers === null ? <div className="empty">加载中…</div> : workers.length === 0 ? (
          <div className="empty">尚无 worker 注册（启动 worker 后自动出现）</div>
        ) : (
          <div className="worker-grid">
            {workers.map((w) => (
              <div key={w.id} className="worker-row">
                <span className={`dot ${w.alive ? "on" : ""}`} style={w.alive ? { background: "var(--ok)" } : { opacity: 0.4 }} />
                <span className="mono">{w.id}</span>
                <span className="muted small">
                  {w.alive ? "在线" : "离线"} · 认领 {w.claims_total} / 轮询 {w.polls_total} · 心跳 {w.heartbeats_total}
                  {w.last_task_title ? ` · 最近：${String(w.last_task_title).slice(0, 24)}` : ""}
                </span>
                <span className="mono muted small">{new Date(w.last_seen_at).toLocaleTimeString("zh-CN", { hour12: false })}</span>
              </div>
            ))}
          </div>
        )}
        <div className="modal-actions">
          <button onClick={onClose}>关闭 (Esc)</button>
        </div>
      </div>
    </div>
  );
}

function SummaryCard({ card, onOpen }: { card: WorkCard; onOpen: () => void }) {
  return (
    <button className="summary-card" onClick={onOpen} title="打开检查器查看完整计划与预算分账">
      <div className="sc-row sc-head">
        <span className="role-badge" data-role="Coordinator">Coordinator</span>
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
