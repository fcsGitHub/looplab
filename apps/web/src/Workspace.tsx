import { useEffect, useState } from "react";
import { api, type Attempt, type Candidate, type Task, type WorkCard } from "./api";
import type { EventStreamState } from "./useEventStream";

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
}) {
  const { view, card, tasks, attempts, candidates, goalId, stream, onOpenInspector } = props;
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
        {attempts.length === 0 && <div className="empty">暂无运行</div>}
        {attempts.map((a) => (
          <button key={a.id} className="run-row" onClick={() => onOpenInspector({ kind: "attempt", id: a.id })}>
            <span className="dot" data-state={a.status === "COMMITTED" ? "SUCCEEDED" : a.status} />
            <span className="mono">#{a.attempt_no}</span>
            <span className="sa-title">{a.task_title}</span>
            <span className="role-badge">{a.role}</span>
            <span className="mono muted">{a.status}</span>
            <span className="mono muted">{a.model_calls} calls · ${(Number(a.settled_usd) || 0).toFixed(4)}</span>
          </button>
        ))}
      </div>
    );
  }

  if (view === "evolution") {
    return (
      <div className="ws-body">
        {candidates.length === 0 && <div className="empty">暂无候选。演进循环会从真实失败生成候选。</div>}
        {candidates.map((c) => (
          <button key={c.id} className={`run-row cand`} onClick={() => onOpenInspector({ kind: "candidate", id: c.id })}>
            <span className={`state-chip ${c.status.toLowerCase()}`}>{c.status}</span>
            <span className="mono">{c.digest.slice(0, 8)}</span>
            <span className="sa-title">{c.title || c.kind}</span>
            <span className="mono muted">{(c.history ?? []).length} 状态记录</span>
          </button>
        ))}
        <ReleaseList goalId={goalId} />
      </div>
    );
  }

  return <EvidenceView goalId={goalId} onOpenInspector={onOpenInspector} stream={stream} />;
}

function ReleaseList({ goalId }: { goalId: string }) {
  const [releases, setReleases] = useState<Awaited<ReturnType<typeof api.releases>>["releases"]>([]);
  const [pointers, setPointers] = useState<Awaited<ReturnType<typeof api.pointers>>["pointers"]>([]);
  useEffect(() => {
    api.releases(goalId).then((r) => setReleases(r.releases)).catch(() => {});
    api.pointers().then((r) => setPointers(r.pointers)).catch(() => {});
  }, [goalId]);
  if (!releases.length && !pointers.length) return null;
  return (
    <>
      <div className="eyebrow" style={{ marginTop: 12 }}>发布与指针</div>
      {pointers.map((p) => (
        <div key={p.scope} className="run-row static">
          <span className="state-chip released">指针</span>
          <span className="mono small">{p.scope}</span>
          <span className="mono muted">v{p.pointer_version} · {p.release_id}</span>
        </div>
      ))}
      {releases.map((r) => (
        <div key={r.id} className="run-row static">
          <span className={`state-chip ${r.status === "ROLLED_BACK" ? "rolled_back" : r.kind}`}>{r.status}</span>
          <span className="mono small">{r.id}</span>
          <span className="mono muted">{r.kind} · {fmtTime(r.created_at)}</span>
        </div>
      ))}
    </>
  );
}

function EvidenceView({ goalId, onOpenInspector, stream }: { goalId: string; onOpenInspector: (s: InspectorSpec) => void; stream: EventStreamState }) {
  const [ev, setEv] = useState<Awaited<ReturnType<typeof api.evidence>> | null>(null);
  useEffect(() => {
    api.evidence(goalId).then(setEv).catch(() => {});
  }, [goalId, stream.events.length]);
  if (!ev) return <div className="empty pad">加载中…</div>;
  const nothing = !ev.artifacts.length && !ev.claims.length && !ev.hypotheses.length && !ev.skills.length;
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
    </div>
  );
}

export function Inspector(props: {
  spec: InspectorSpec; onClose: () => void;
  card: WorkCard | null; attempts: Attempt[]; tasks: Task[]; goalId: string | null;
  candidates: Candidate[];
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
      <div className="insp-body">
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
          return (
            <>
              <Row label="标题">{t.title}</Row>
              <Row label="角色">{t.role} · {t.kind}</Row>
              <Row label="状态">{t.state}</Row>
              <Row label="重试">{t.failure_count} 次失败 · 访问 {t.visit_count} 次</Row>
            </>
          );
        })()}
        {spec.kind === "attempt" && (
          <>
            <Row label="事件日志（按时间）"><span className="mono small">原始事件，点击运行行刷新</span></Row>
            <pre className="log mono">{detail ?? "加载中…"}</pre>
          </>
        )}
        {spec.kind === "candidate" && <CandidateDetail candidates={props.candidates} id={spec.id} />}
        {spec.kind === "claim" && <div className="empty">Claim 详情见证据页行内容。</div>}
        {spec.kind === "hypothesis" && <div className="empty">假设卡详情见证据页行内容。</div>}
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
