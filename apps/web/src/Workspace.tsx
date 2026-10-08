import { useEffect, useState } from "react";
import { api, type Attempt, type Candidate, type Task, type WorkCard } from "./api";
import type { EventStreamState } from "./useEventStream";
import { Trajectory } from "./Trajectory";
import { EvolutionView } from "./Evolution";
import { TaskGraph } from "./TaskGraph";

type InspectorSpec = { kind: string; id: string };

export function Workspace(props: {
  view: "work" | "runs" | "evolution" | "evidence";
  card: WorkCard | null;
  tasks: Task[];
  attempts: Attempt[];
  candidates: Candidate[];
  goalId: string | null;
  stream: EventStreamState;
  onOpenInspector: (s: InspectorSpec) => void;
  userRole?: string;
}) {
  const { view, card, tasks, attempts, candidates, goalId, stream, onOpenInspector, userRole } = props;
  if (!goalId || !card) return <div className="empty pad">选择或创建一个会话并发送目标。</div>;

  if (view === "work") {
    return (
      <div className="ws-body">
        <Row label="版本">{card.graph_version ?? "—"}</Row>
        <Row label="正在做">{card.doing ?? "—"}</Row>
        <Row label="最近有效进展">{card.last_progress ?? "—"}</Row>
        <Row label="等待原因">{card.waiting_reason ?? "无"}</Row>
        <Row label="下一步">{card.next_step ?? "—"}</Row>
        <Row label="核验进度">
          {card.verified
            ? <>已验证 {card.verified.done}/{card.verified.total} <span className="muted">（分母：固定合同批次）</span></>
            : <span className="muted">开放研究：不显示整体完成百分比</span>}
        </Row>
        <Row label="剩余额度">
          <span className="mono">已用 ${card.budget.used.toFixed(4)} · 未结算 ${card.budget.unknown.toFixed(4)} · 上限 ${card.budget.cap}</span>
        </Row>
        <Row label="三类活性">
          <span className="mono small">
            心跳 {fmtTime(card.last_heartbeat_at)} · 工具进度 {fmtTime(card.last_tool_progress_at)}
          </span>
        </Row>
        <div className="eyebrow" style={{ marginTop: 12 }}>任务图</div>
        {tasks.length > 0 && (
          <TaskGraph tasks={tasks} onOpen={(id) => onOpenInspector({ kind: "task", id })} />
        )}
        <div className="graph-mini">
          {tasks.map((t) => (
            <button key={t.id} className="node" data-state={t.state} onClick={() => onOpenInspector({ kind: "task", id: t.id })} title={`${t.title} · ${t.state}`}>
              {t.node_key}
            </button>
          ))}
          {tasks.length === 0 && <span className="muted">尚无任务</span>}
        </div>
      </div>
    );
  }

  if (view === "runs") {
    return (
      <div className="ws-body">
        {goalId && attempts.length > 0 && (
          <a className="run-row static report-link" href={api.reportUrl(goalId)} title="从真实事件账本导出 Markdown 运行报告">
            <span className="role-badge" data-role="Curator">导出</span>
            <span className="sa-title">运行报告 report.md</span>
            <span className="mono muted">任务图 · 执行与花费 · 时间线 · 交付物</span>
          </a>
        )}
        {attempts.length === 0 && <div className="empty">暂无运行</div>}
        {attempts.map((a) => (
          <button key={a.id} className="run-row" onClick={() => onOpenInspector({ kind: "attempt", id: a.id })}>
            <span className="dot" data-state={a.status === "COMMITTED" ? "SUCCEEDED" : a.status} />
            <span className="mono">#{a.attempt_no}</span>
            <span className="sa-title">{a.task_title}</span>
            <span className="role-badge" data-role={a.role}>{a.role}</span>
            <span className="mono muted">{a.status}</span>
            <span className="mono muted">{a.model_calls} calls · ${(Number(a.settled_usd) || 0).toFixed(4)}</span>
          </button>
        ))}
      </div>
    );
  }

  if (view === "evolution") {
    return <EvolutionView goalId={goalId} candidates={candidates} stream={stream} onOpenInspector={onOpenInspector} userRole={userRole} />;
  }

  return <EvidenceView goalId={goalId} onOpenInspector={onOpenInspector} stream={stream} />;
}

function EvidenceView({ goalId, onOpenInspector, stream }: { goalId: string; onOpenInspector: (s: InspectorSpec) => void; stream: EventStreamState }) {
  const [ev, setEv] = useState<Awaited<ReturnType<typeof api.evidence>> | null>(null);
  useEffect(() => {
    api.evidence(goalId).then(setEv).catch(() => {});
  }, [goalId, stream.events.length]);
  if (!ev) return <div className="empty pad">加载中…</div>;
  const nothing = !ev.artifacts.length && !ev.claims.length && !ev.hypotheses.length && !ev.skills.length && !(ev.memories ?? []).length;
  if (nothing) return <div className="empty pad">暂无证据与资产。</div>;
  return (
    <div className="ws-body">
      {ev.artifacts.length > 0 && <div className="eyebrow">Artifact（内容寻址，不可变）</div>}
      {ev.artifacts.map((a) => (
        <a key={a.digest} className="run-row static" href={api.artifactUrl(a.digest)} target="_blank" rel="noreferrer">
          <span className="mono">{a.digest.slice(0, 10)}</span>
          <span className="sa-title">{a.name}</span>
          <span className="mono muted">{a.media_type} · {a.size_bytes}B · {a.producer_role}</span>
        </a>
      ))}
      {ev.claims.length > 0 && <div className="eyebrow">Claim（立场 + 范围）</div>}
      {ev.claims.map((c) => (
        <button key={c.id} className="run-row static" onClick={() => onOpenInspector({ kind: "claim", id: c.id })}>
          <span className={`state-chip ${c.stance === "条件内支持" ? "released" : c.stance === "证据不足" ? "inconclusive" : "rejected"}`}>{c.stance}</span>
          <span className="sa-title">{c.text.slice(0, 90)}</span>
        </button>
      ))}
      {ev.hypotheses.length > 0 && <div className="eyebrow">假设卡</div>}
      {ev.hypotheses.map((h) => (
        <button key={h.id} className="run-row static" onClick={() => onOpenInspector({ kind: "hypothesis", id: h.id })}>
          <span className="role-badge">{h.stage}</span>
          <span className="sa-title">{h.statement.slice(0, 80)}</span>
          <span className="mono muted">{h.verdict ?? h.state}</span>
        </button>
      ))}
      {ev.skills.length > 0 && <div className="eyebrow">技能候选</div>}
      {ev.skills.map((s) => (
        <div key={s.id} className="run-row static">
          <span className="state-chip candidate">candidate</span>
          <span className="sa-title">{s.name} v{s.version}</span>
        </div>
      ))}
      {ev.memories.length > 0 && <div className="eyebrow">记忆（真实沉淀，按效用标注）</div>}
      {ev.memories.map((m) => (
        <div key={m.id} className="run-row static memory-row" title={`效用：${m.utility}`}>
          <span className={`state-chip ${m.utility === "helpful" ? "released" : m.utility === "harmful" ? "rejected" : "candidate"}`}>{m.utility}</span>
          <span className="role-badge" data-role="Curator">{m.kind}</span>
          <span className="sa-title">{m.content.slice(0, 110)}</span>
        </div>
      ))}
    </div>
  );
}

export function Inspector(props: {
  spec: InspectorSpec; onClose: () => void;
  card: WorkCard | null; attempts: Attempt[]; tasks: Task[]; goalId: string | null;
  candidates: Candidate[];
  onOpenInspector?: (s: InspectorSpec) => void;
}) {
  const { spec, onClose } = props;
  const [detail, setDetail] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (spec.kind === "attempt") {
      api.attemptEvents(spec.id).then((r) =>
        setDetail(r.events.map((e) => `${e.occurred_at.slice(11, 19)} ${e.event_type} ${JSON.stringify(e.payload).slice(0, 220)}`).join("\n")),
      ).catch(() => setDetail("(无法加载事件)"));
    } else if (spec.kind === "task") {
      setDetail(null);
    }
  }, [spec]);

  const title = spec.kind === "goal" ? "目标检查器"
    : spec.kind === "attempt" ? `Attempt ${spec.id}`
    : spec.kind === "task" ? "任务详情"
    : spec.kind === "candidate" ? "候选详情"
    : spec.id;

  return (
    <div className="inspector" role="dialog" aria-label={title}>
      <div className="insp-head">
        <span>{title}</span>
        <button className="ghost" onClick={onClose}>关闭 (Esc)</button>
      </div>
      <div className={`insp-body ${spec.kind === "attempt" ? "traj-host" : ""}`}>
        {spec.kind === "goal" && props.card && (
          <>
            <Row label="目标">{props.card.objective}</Row>
            <Row label="状态">{props.card.state}</Row>
            <Row label="预算分账">
              <span className="mono small">已结算 ${props.card.budget.used.toFixed(4)} · 未结算(保守预留) ${props.card.budget.unknown.toFixed(4)} · 上限 ${props.card.budget.cap}</span>
            </Row>
            <Row label="检查点与计划">任务图见“当前工作”页；检查点随每次有界步骤写入。</Row>
          </>
        )}
        {spec.kind === "task" && (() => {
          const t = props.tasks.find((x) => x.id === spec.id);
          if (!t) return <div className="empty">任务不存在</div>;
          const taskAttempts = props.attempts.filter((a) => a.task_id === t.id)
            .sort((a, b) => b.attempt_no - a.attempt_no);
          const lastFailed = taskAttempts.find((a) => a.error_class);
          return (
            <>
              <Row label="标题">{t.title}</Row>
              <Row label="角色">{t.role} · {t.kind}</Row>
              <Row label="状态">
                <span className={`state-chip ${t.state.toLowerCase()}`}>{t.state}</span>
                <span className="mono muted small" style={{ marginLeft: 8 }}>
                  {t.node_key}{t.graph_version ? ` · 图 ${t.graph_version}` : ""}
                </span>
              </Row>
              <Row label="依赖">
                {(t.depends_on ?? []).length === 0
                  ? <span className="muted">无（根节点）</span>
                  : (t.depends_on ?? []).map((d) => <span key={d} className="dep-chip mono">{d}</span>)}
              </Row>
              <Row label="重试">{t.failure_count} 次失败 · 访问 {t.visit_count} 次</Row>
              {lastFailed && (
                <Row label="最近错误类">
                  <span className="mono small">{lastFailed.error_class}</span>
                  <span className="muted small" style={{ marginLeft: 6 }}>· attempt #{lastFailed.attempt_no}</span>
                </Row>
              )}
              <div className="eyebrow" style={{ marginTop: 10 }}>执行尝试（{taskAttempts.length}）</div>
              {taskAttempts.length === 0 && <div className="muted small">尚未派发</div>}
              {taskAttempts.map((a) => (
                <button key={a.id} className="run-row" onClick={() => props.onOpenInspector?.({ kind: "attempt", id: a.id })} title="打开轨迹检查器">
                  <span className="dot" data-state={a.status === "COMMITTED" ? "SUCCEEDED" : a.status} />
                  <span className="mono">#{a.attempt_no}</span>
                  <span className="mono muted">{a.status}</span>
                  <span className="mono muted small">{a.model_calls} calls · ${(Number(a.settled_usd) || 0).toFixed(4)}</span>
                  <span className="mono dim small">{a.ended_at ? fmtTime(a.ended_at) : ""}</span>
                </button>
              ))}
            </>
          );
        })()}
        {spec.kind === "attempt" && (() => {
          const att = props.attempts.find((a) => a.id === spec.id);
          const live = !!att && ["LEASED", "STARTED", "RUNNING", "RESULT_PENDING"].includes(att.status);
          return (
            <>
              {att && (
                <div className="traj-host-pad">
                  <Row label="任务">{att.task_title}</Row>
                  <Row label="状态">
                    <span className={`state-chip ${att.status.toLowerCase()}`}>{att.status}</span>
                    <span className="mono muted small" style={{ marginLeft: 8 }}>
                      {att.model_calls} 次模型调用 · ${(Number(att.settled_usd) || 0).toFixed(4)}
                    </span>
                  </Row>
                </div>
              )}
              <Trajectory attemptId={spec.id} live={live} />
              <details className="raw-events">
                <summary className="muted small">原始事件 JSON（调试）</summary>
                <pre className="log mono">{detail ?? "加载中…"}</pre>
              </details>
            </>
          );
        })()}
        {spec.kind === "candidate" && <CandidateDetail candidates={props.candidates} id={spec.id} />}
        {spec.kind === "claim" && props.goalId && <ClaimDetail goalId={props.goalId} id={spec.id} />}
        {spec.kind === "hypothesis" && props.goalId && <HypothesisDetail goalId={props.goalId} id={spec.id} />}
      </div>
    </div>
  );
}

function CandidateDetail({ candidates, id }: { candidates: Candidate[]; id: string }) {
  const cand = candidates.find((c) => c.id === id) ?? null;
  if (!cand) return <div className="empty">候选不存在。</div>;
  return (
    <>
      <Row label="标题">{cand.title}</Row>
      <Row label="状态">{cand.status}</Row>
      <Row label="digest"><span className="mono">{cand.digest}</span></Row>
      <Row label="回滚方式">回滚 = 将版本指针切回父版本；已发生的外部副作用需另行处理。</Row>
      <div className="eyebrow" style={{ marginTop: 10 }}>状态历史</div>
      {(cand.history ?? []).map((h, i) => (
        <div key={i} className="run-row static"><span className="mono small">{fmtTime(h.at)}</span><span className="sa-title">{h.status}</span><span className="muted small">{h.reason?.slice(0, 80)}</span></div>
      ))}
    </>
  );
}

function ClaimDetail({ goalId, id }: { goalId: string; id: string }) {
  const [claim, setClaim] = useState<null | "missing" | (Awaited<ReturnType<typeof api.evidence>>["claims"][number])>(null);
  useEffect(() => {
    api.evidence(goalId)
      .then((r) => setClaim(r.claims.find((c) => c.id === id) ?? "missing"))
      .catch(() => setClaim("missing"));
  }, [goalId, id]);
  if (claim === null) return <div className="empty">加载中…</div>;
  if (claim === "missing") return <div className="empty">Claim 不存在或不可见。</div>;
  const refs = Array.isArray(claim.evidence_refs) ? (claim.evidence_refs as unknown[]) : [];
  return (
    <>
      <Row label="立场">
        <span className={`state-chip ${claim.stance === "条件内支持" ? "released" : claim.stance === "证据不足" ? "inconclusive" : "rejected"}`}>{claim.stance}</span>
      </Row>
      <Row label="内容">{claim.text}</Row>
      <Row label="适用范围">{claim.scope || "—"}</Row>
      <Row label="类型">{claim.kind}</Row>
      <div className="eyebrow" style={{ marginTop: 10 }}>证据引用</div>
      {refs.length === 0 ? <div className="muted small">无引用</div> : refs.map((r, i) => (
        <div key={i} className="run-row static"><span className="mono small">{typeof r === "string" ? r : JSON.stringify(r).slice(0, 60)}</span></div>
      ))}
    </>
  );
}

function HypothesisDetail({ goalId, id }: { goalId: string; id: string }) {
  const [hyp, setHyp] = useState<null | "missing" | import("./api").HypothesisRow>(null);
  useEffect(() => {
    api.hypotheses(goalId)
      .then((r) => setHyp(r.hypotheses.find((h) => h.id === id) ?? "missing"))
      .catch(() => setHyp("missing"));
  }, [goalId, id]);
  if (hyp === null) return <div className="empty">加载中…</div>;
  if (hyp === "missing") return <div className="empty">假设卡不存在或不可见。</div>;
  const verdictTone = hyp.verdict === "supported_in_scope" ? "released"
    : hyp.verdict === "falsified_in_scope" || hyp.verdict === "implementation_failed" ? "rejected" : "inconclusive";
  return (
    <>
      <Row label="陈述">{hyp.statement}</Row>
      <Row label="阶段/状态">
        <span className="role-badge">{hyp.stage}</span>{" "}
        <span className="state-chip candidate">{hyp.state}</span>
        {hyp.verdict && <span className={`state-chip ${verdictTone}`} style={{ marginLeft: 6 }}>{hyp.verdict}</span>}
      </Row>
      <Row label="机制">{hyp.mechanism || "—"}</Row>
      <Row label="适用条件">{hyp.applicability || "—"}</Row>
      <Row label="关键变量">{hyp.key_variable || "—"}</Row>
      <Row label="可证伪预测">{hyp.falsifier || "—"}</Row>
      <Row label="主指标">
        {hyp.primary_metric || "—"}{hyp.min_effect != null && <span className="mono muted small"> · 最小效应 {hyp.min_effect}</span>}
      </Row>
      <Row label="下一步">{hyp.next_step || "—"}</Row>
      <Row label="复活条件">{hyp.revive_condition || "—"}</Row>
    </>
  );
}

export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="row">
      <span className="row-label">{label}</span>
      <span className="row-value">{children}</span>
    </div>
  );
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString("zh-CN", { hour12: false });
  } catch { return "—"; }
}
