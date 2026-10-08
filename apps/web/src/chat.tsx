import type { Message, PlatformEvent } from "./api";

/* 对话流：用户消息（DB）+ Agent 里程碑（SSE 真实事件派生）。
   设计 §16：对话流 = 用户消息 / Agent 消息（可嵌紧凑数据卡）。
   所有卡片字段来自事件 payload，不虚构进度或成功率。 */

export type TimelineEntry =
  | { kind: "user"; id: string; at: number; text: string; role: string }
  | { kind: "milestone"; id: string; at: number; event: PlatformEvent };

const MILESTONE_TYPES = new Set([
  "goal.created", "goal.graph_planned", "goal.completed", "goal.verification_failed",
  "goal.stalled", "goal.revise_capped", "goal.priority_changed", "goal.steer_accepted",
  "attempt.committed", "task.failed", "approval.requested", "evaluation.completed",
  "release.promoted", "release.rolled_back", "release.rolled_back_to", "steer.applied",
]);

const ts = (iso: string) => {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
};

export function mergeTimeline(messages: Message[], events: PlatformEvent[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const m of messages) {
    entries.push({ kind: "user", id: m.id, at: ts(m.created_at), text: m.content, role: m.role });
  }
  for (const e of events) {
    if (!MILESTONE_TYPES.has(e.event_type)) continue;
    entries.push({ kind: "milestone", id: e.event_id, at: ts(e.occurred_at), event: e });
  }
  entries.sort((a, b) => a.at - b.at);
  return entries;
}

export interface MilestoneView {
  tone: "ok" | "warn" | "danger" | "info";
  head: string;
  meta: string;
  lines: string[];
  /** 卡片可点入的检查器（attempt.committed → 轨迹；goal.* → 目标检查器） */
  inspector?: { kind: string; id: string };
}

export function milestoneView(e: PlatformEvent): MilestoneView | null {
  const p = (e.payload ?? {}) as any;
  switch (e.event_type) {
    case "goal.created":
      return {
        tone: "info", head: "目标已接受，开始规划任务图", meta: "",
        lines: [String(p.objective ?? "").slice(0, 160)],
        inspector: { kind: "goal", id: e.goal_id ?? e.aggregate_id },
      };
    case "goal.graph_planned": {
      const nodes: { key: string; role: string; title: string }[] = Array.isArray(p.nodes) ? p.nodes : [];
      const lines = nodes.slice(0, 8).map((n) => `${n.key} · ${n.role} · ${n.title}`);
      if (nodes.length > 8) lines.push(`…共 ${nodes.length} 个节点`);
      if (p.note) lines.push(`规划备注：${String(p.note).slice(0, 140)}`);
      return {
        tone: "info",
        head: p.revision ? `任务图已修订 · ${nodes.length} 个节点` : `任务图已规划 · ${nodes.length} 个节点`,
        meta: p.revision && p.valid_prefix != null ? `保留有效前缀 ${p.valid_prefix}` : "",
        lines,
        inspector: { kind: "goal", id: e.goal_id ?? e.aggregate_id },
      };
    }
    case "attempt.committed": {
      // 真实 outcome 取值：SUCCEEDED / FAILED（worker runtime 上报）
      const ok = p.outcome === "SUCCEEDED";
      const bad = p.outcome === "FAILED";
      const usage = p.usage ? `${p.usage.prompt_tokens ?? "?"}→${p.usage.completion_tokens ?? "?"} tok` : "";
      return {
        tone: ok ? "ok" : bad ? "danger" : "warn",
        head: ok ? "子任务已提交" : `子任务结束 · ${p.outcome ?? "未定"}`,
        meta: usage,
        lines: p.summary ? [String(p.summary).slice(0, 400)] : [],
        inspector: { kind: "attempt", id: e.aggregate_id },
      };
    }
    case "task.failed": {
      // 真实 payload：{attempt_id, summary, outcome}（goals.ts onAttemptCommitted）
      return {
        tone: "warn",
        head: `任务失败 · ${p.outcome ?? "未定"}`,
        meta: "",
        lines: p.summary ? [String(p.summary).slice(0, 200)] : [],
        inspector: p.attempt_id ? { kind: "attempt", id: String(p.attempt_id) } : undefined,
      };
    }
    case "approval.requested": {
      const kindLabel = p.kind === "goal_revise" ? "目标修订" : String(p.kind ?? "审批");
      return {
        tone: "warn",
        head: `等待人工审批 · ${kindLabel}`,
        meta: p.diagnose_node ? `诊断节点 ${p.diagnose_node}` : "",
        lines: ["诊断已完成，需要人工批准后才会自动重规划（防幻觉护栏）。"],
      };
    }
    case "goal.revise_capped":
      return {
        tone: "danger",
        head: "修订上限护栏已触发",
        meta: p.applied_revisions != null ? `已应用 ${p.applied_revisions} 次` : "",
        lines: p.reason ? [String(p.reason).slice(0, 200)] : [],
        inspector: { kind: "goal", id: e.goal_id ?? e.aggregate_id },
      };
    case "goal.priority_changed":
      return {
        tone: "info",
        head: `调度优先级 ${p.from} → ${p.to}`,
        meta: "1 最急 · 9 最不急",
        lines: [],
        inspector: { kind: "goal", id: e.goal_id ?? e.aggregate_id },
      };
    case "goal.steer_accepted":
      return {
        tone: "info",
        head: "引导已接受，下一轮生效",
        meta: "",
        lines: p.note ? [String(p.note).slice(0, 160)] : [],
        inspector: { kind: "goal", id: e.goal_id ?? e.aggregate_id },
      };
    case "evaluation.completed": {
      const verdict: string = p.verdict ?? "—";
      const tone = verdict === "ELIGIBLE" ? "ok" : verdict === "REJECTED" ? "danger" : "warn";
      return {
        tone,
        head: `评测完成 · ${verdict}`,
        meta: p.layer ? `层：${p.layer}` : "",
        lines: p.primary?.value != null ? [`${p.primary.metric} = ${p.primary.value}`] : [],
      };
    }
    case "release.promoted":
      return {
        tone: "ok",
        head: `候选已发布 · ${p.kind ?? "canary"}`,
        meta: p.scope ? `${p.scope} · 指针 v${p.pointer_version ?? "?"}` : "",
        lines: [],
      };
    case "release.rolled_back":
    case "release.rolled_back_to":
      return {
        tone: "warn",
        head: "版本指针已回滚",
        meta: p.scope ?? "",
        lines: p.reason ? [String(p.reason).slice(0, 160)] : [],
      };
    case "goal.stalled":
      return {
        tone: "warn",
        head: "看门狗：目标停滞",
        meta: "",
        lines: p.detail ? [String(p.detail).slice(0, 200)] : [],
        inspector: { kind: "goal", id: e.goal_id ?? e.aggregate_id },
      };
    case "goal.verification_failed":
      return {
        tone: "danger",
        head: "最终核验未通过",
        meta: "",
        lines: p.detail ? [String(p.detail).slice(0, 240)] : [],
        inspector: { kind: "goal", id: e.goal_id ?? e.aggregate_id },
      };
    case "goal.completed":
      return {
        tone: "ok",
        head: "目标已完成 ✔",
        meta: "",
        lines: p.detail ? [String(p.detail).slice(0, 240)] : [],
        inspector: { kind: "goal", id: e.goal_id ?? e.aggregate_id },
      };
    case "steer.applied":
      return {
        tone: "info",
        head: "引导已应用（下一轮生效）",
        meta: "",
        lines: p.content || p.text ? [String(p.content ?? p.text).slice(0, 200)] : [],
      };
    default:
      return null;
  }
}

export const TONE_GLYPH: Record<MilestoneView["tone"], string> = {
  ok: "✓", warn: "▲", danger: "✕", info: "◆",
};
