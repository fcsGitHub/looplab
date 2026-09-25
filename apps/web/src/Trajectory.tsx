import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type PlatformEvent } from "./api";

/* DeepSeek Harness 风格轨迹视图：
   顶部 Input/Model/Tools 三车道活动带 + 结构化时间线。
   数据全部来自 /v1/attempts/:id/events 的真实事件流。 */

type Lane = "input" | "model" | "tools";

const LANE_LABEL: Record<Lane, string> = { input: "Input", model: "Model", tools: "Tools" };

function laneOf(e: PlatformEvent): Lane {
  if (e.event_type.startsWith("model.")) return "model";
  if (e.event_type.startsWith("tool.")) return "tools";
  return "input";
}

type Status = "ok" | "fail" | "warn" | "info" | "muted";

function statusOf(e: PlatformEvent): Status {
  const t = e.event_type;
  if (t === "tool.call_denied" || t === "model.call_failed" || t === "attempt.late_commit_quarantined" || t === "task.failed") return "fail";
  if (t === "tool.call_completed") return e.payload?.ok === false ? "fail" : "ok";
  if (t === "model.call_completed" || t === "attempt.committed" || t === "task.succeeded") return "ok";
  if (t === "tool.call_authorized" || t === "attempt.reconcile_required" || t === "attempt.lost") return "warn";
  if (t === "checkpoint.saved" || t === "steer.applied") return "info";
  return "muted";
}

const ROW_LABEL: Record<string, string> = {
  "attempt.leased": "Attempt 被领取",
  "attempt.started": "Attempt 开始执行",
  "attempt.committed": "Attempt 已提交",
  "attempt.lost": "Attempt 失联",
  "attempt.reconcile_required": "需要对账",
  "attempt.late_commit_quarantined": "迟到提交已隔离",
  "task.succeeded": "任务成功",
  "task.failed": "任务失败",
  "task.rescheduled": "任务重新调度",
  "task.retry_loop_diagnosed": "重试循环已诊断",
  "steer.applied": "引导已应用（下轮生效）",
  "checkpoint.saved": "检查点",
  "model.call_started": "模型调用开始",
  "model.call_completed": "模型调用完成",
  "model.call_failed": "模型调用失败",
  "tool.call_authorized": "工具调用已授权",
  "tool.call_denied": "工具调用被拒绝",
  "tool.call_completed": "工具调用完成",
  "completion.claimed": "结果已认领",
};

export function Trajectory({ attemptId, live }: { attemptId: string; live: boolean }) {
  const [events, setEvents] = useState<PlatformEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lanes, setLanes] = useState<Record<Lane, boolean>>({ input: true, model: true, tools: true });
  const [follow, setFollow] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const bodyRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const load = useCallback(() => {
    api.attemptEvents(attemptId)
      .then((r) => { setEvents(r.events); setError(null); })
      .catch(() => setError("无法加载事件"));
  }, [attemptId]);

  useEffect(() => { setEvents(null); load(); }, [load]);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [live, load]);

  // 跟随滚动：用户上滑则暂停跟随，回底恢复
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !follow || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [events, follow]);

  const onScroll = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }, []);

  // 模型调用配对：causation_id 把 started/completed/failed 连成一次调用，算耗时
  const callPairs = useMemo(() => {
    const m = new Map<string, PlatformEvent>();
    for (const e of events ?? []) {
      if (e.event_type === "model.call_started" && e.causation_id) m.set(e.causation_id as string, e);
    }
    return m;
  }, [events]);

  const filtered = useMemo(
    () => (events ?? []).filter((e) => lanes[laneOf(e)]),
    [events, lanes],
  );

  const stats = useMemo(() => {
    const s: Record<Lane, { n: number; last: string | null; active: boolean }> = {
      input: { n: 0, last: null, active: false },
      model: { n: 0, last: null, active: false },
      tools: { n: 0, last: null, active: false },
    };
    for (const e of events ?? []) {
      const l = laneOf(e);
      s[l].n += 1;
      s[l].last = e.occurred_at;
    }
    const now = Date.now();
    for (const l of ["input", "model", "tools"] as Lane[]) {
      s[l].active = s[l].last != null && now - new Date(s[l].last!).getTime() < 4000 && live;
    }
    return s;
  }, [events, live]);

  const span = useMemo(() => {
    if (!events?.length) return null;
    const t0 = new Date(events[0].occurred_at).getTime();
    const t1 = new Date(events[events.length - 1].occurred_at).getTime();
    return { t0, t1: Math.max(t1, t0 + 1) };
  }, [events]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  return (
    <div className="traj">
      {/* 三车道活动带 */}
      <div className="traj-band" role="group" aria-label="活动车道">
        {(["input", "model", "tools"] as Lane[]).map((l) => (
          <button
            key={l}
            className={`traj-lane ${lanes[l] ? "" : "off"}`}
            onClick={() => setLanes((p) => ({ ...p, [l]: !p[l] }))}
            title={`${lanes[l] ? "隐藏" : "显示"} ${LANE_LABEL[l]} 车道事件`}
          >
            <span className="traj-lane-head">
              <span className={`traj-lane-dot ${l} ${stats[l].active ? "live" : ""}`} />
              <span className="traj-lane-name">{LANE_LABEL[l]}</span>
              <span className="traj-lane-count num">{stats[l].n}</span>
            </span>
            <span className="traj-lane-track">
              {span && (events ?? []).filter((e) => laneOf(e) === l).map((e) => (
                <i
                  key={e.event_id}
                  className={`tick ${statusOf(e)}`}
                  style={{ left: `${((new Date(e.occurred_at).getTime() - span.t0) / (span.t1 - span.t0)) * 100}%` }}
                />
              ))}
            </span>
          </button>
        ))}
        <button
          className={`ghost traj-follow ${follow ? "on" : ""}`}
          onClick={() => { setFollow((v) => !v); stickRef.current = true; }}
          title="跟随最新事件滚动"
        >
          {follow ? "跟随 ↓" : "已暂停跟随"}
        </button>
      </div>

      {/* 结构化时间线 */}
      <div className="traj-body" ref={bodyRef} onScroll={onScroll} role="log" aria-label="执行轨迹">
        {error && <div className="empty">{error}</div>}
        {!error && events === null && <div className="empty">加载中…</div>}
        {!error && events !== null && filtered.length === 0 && (
          <div className="empty">当前过滤条件下没有事件。</div>
        )}
        {filtered.map((e) => (
          <TrajRow
            key={e.event_id}
            e={e}
            pairStart={e.causation_id ? callPairs.get(e.causation_id as string) : undefined}
            open={expanded.has(e.event_id)}
            onToggle={() => toggle(e.event_id)}
          />
        ))}
        {live && <div className="traj-live-hint mono">● 实时 · 每 2s 刷新</div>}
      </div>
    </div>
  );
}

function TrajRow({ e, pairStart, open, onToggle }: {
  e: PlatformEvent;
  pairStart?: PlatformEvent;
  open: boolean;
  onToggle: () => void;
}) {
  const st = statusOf(e);
  const lane = laneOf(e);
  const p = e.payload ?? {};
  const time = new Date(e.occurred_at).toLocaleTimeString("zh-CN", { hour12: false });
  const hasDetail = Object.keys(p).length > 0;
  const durMs = pairStart && e.event_type !== "model.call_started"
    ? new Date(e.occurred_at).getTime() - new Date(pairStart.occurred_at).getTime()
    : null;

  return (
    <div className={`traj-row ${st}`} data-lane={lane}>
      <span className="traj-time mono dim">{time}</span>
      <span className={`traj-glyph ${st}`} aria-hidden="true">{glyph(e)}</span>
      <div className="traj-card">
        <button className="traj-summary" onClick={onToggle} disabled={!hasDetail} aria-expanded={open}>
          <span className="traj-title">{title(e)}</span>
          <span className="traj-meta mono dim">{meta(e, durMs)}</span>
          {hasDetail && <span className={`traj-caret ${open ? "open" : ""}`}>›</span>}
        </button>
        {open && hasDetail && (
          <pre className="traj-detail mono">{JSON.stringify(p, null, 2)}</pre>
        )}
      </div>
    </div>
  );
}

function glyph(e: PlatformEvent): string {
  const t = e.event_type;
  if (t.startsWith("model.call_started")) return "◐";
  if (t.startsWith("model.call_completed")) return "●";
  if (t.startsWith("model.call_failed")) return "✕";
  if (t === "tool.call_authorized") return "⚿";
  if (t === "tool.call_denied") return "⊘";
  if (t === "tool.call_completed") return "⚙";
  if (t === "checkpoint.saved") return "◈";
  if (t === "steer.applied") return "⇢";
  if (t.endsWith(".committed") || t.endsWith(".succeeded")) return "✓";
  if (t.endsWith(".failed") || t.endsWith(".lost")) return "✕";
  return "·";
}

function title(e: PlatformEvent): string {
  const p = e.payload ?? {};
  switch (e.event_type) {
    case "model.call_started": return `调用模型 ${p.model ?? ""}`.trim();
    case "model.call_completed": return `${p.model ?? "模型"} 返回 (${p.finish_reason ?? "—"})`;
    case "model.call_failed": return `模型调用失败：${String(p.error ?? "").slice(0, 80)}`;
    case "tool.call_authorized": return `授权工具 ${p.tool}`;
    case "tool.call_denied": return `拒绝工具 ${p.tool}：${String(p.reason ?? "").slice(0, 60)}`;
    case "tool.call_completed": return `工具 ${p.tool} ${p.ok === false ? "失败" : "完成"}`;
    case "checkpoint.saved": return `检查点 #${p.step_index} · ${String(p.summary ?? "").slice(0, 70) || "—"}`;
    case "steer.applied": return `引导：${String(p.content ?? p.text ?? JSON.stringify(p)).slice(0, 70)}`;
    default: return ROW_LABEL[e.event_type] ?? e.event_type;
  }
}

function meta(e: PlatformEvent, durMs: number | null): string {
  const p = e.payload ?? {};
  const parts: string[] = [];
  if (e.event_type === "model.call_started" && p.reserved_usd != null) parts.push(`预留 $${Number(p.reserved_usd).toFixed(4)}`);
  if (e.event_type === "model.call_completed") {
    if (p.prompt_tokens != null) parts.push(`${p.prompt_tokens}→${p.completion_tokens} tok`);
    if (p.cost_usd != null) parts.push(`$${Number(p.cost_usd).toFixed(5)}`);
  }
  if (e.event_type === "tool.call_authorized" && p.args_size != null) parts.push(`参数 ${p.args_size}B`);
  if (e.event_type === "tool.call_completed") {
    if (p.duration_ms != null) parts.push(`${p.duration_ms}ms`);
    if (p.output_bytes != null) parts.push(`输出 ${p.output_bytes}B`);
  }
  if (durMs != null && e.event_type !== "tool.call_completed") parts.push(`${durMs}ms`);
  return parts.join(" · ");
}
