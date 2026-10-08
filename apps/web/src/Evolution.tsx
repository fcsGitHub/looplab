import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api, type Candidate, type EpochInfo, type OptimizerRun, type Pointer, type ProblemRow,
  type ProposalRow, type ReleaseRow,
} from "./api";
import type { EventStreamState } from "./useEventStream";
import { LineChart, StatCard, type Series, type VMarker } from "./charts";

/* RSI 控制台：epoch 状态 + 实时评测曲线 + 优化器预算燃烧 + 候选/发布。
   评测曲线直接由 SSE 事件流驱动（evaluation.completed 实时追加），
   优化器运行在 RUNNING 时 3s 轮询形成预算燃烧的实时曲线。 */

type InspectorSpec = { kind: string; id: string };

export function EvolutionView(props: {
  goalId: string;
  candidates: Candidate[];
  stream: EventStreamState;
  onOpenInspector: (s: InspectorSpec) => void;
  userRole?: string;
}) {
  const { goalId, candidates, stream, onOpenInspector, userRole } = props;
  const [runs, setRuns] = useState<OptimizerRun[]>([]);
  const [epoch, setEpoch] = useState<EpochInfo | null>(null);
  const [starting, setStarting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    api.optimizerRuns(goalId).then((r) => setRuns(r.runs)).catch(() => {});
    api.metaEpoch().then((r) => setEpoch(r.epoch)).catch(() => {});
  }, [goalId]);

  useEffect(() => { load(); }, [load]);

  // SSE 触发即时刷新（优化器/评测事件），运行中再加 3s 轮询
  const optEventCount = useMemo(
    () => stream.events.filter((e) => e.event_type.startsWith("optimizer.") || e.event_type.startsWith("evaluation.") || e.event_type.startsWith("candidate.") || e.event_type.startsWith("release.")).length,
    [stream.events],
  );
  useEffect(() => {
    if (!optEventCount) return;
    const t = setTimeout(load, 400);
    return () => clearTimeout(t);
  }, [optEventCount, load]);
  const anyRunning = runs.some((r) => r.status === "RUNNING");
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [anyRunning, load]);

  const startRound = useCallback(async () => {
    if (starting) return;
    setStarting(true);
    setNotice(null);
    try {
      // 活跃后端 + active 模式是常规优化轮；挑战者 epoch 试炼由脚本走正式协议
      await api.runOptimizerRound(goalId, epoch?.active_backend ? { backend: epoch.active_backend, mode: "active" } : {});
      setNotice("已派发一轮优化器试炼（后台执行，实时刷新）。");
      load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  }, [goalId, starting, load, epoch]);

  // ---- 评测曲线：SSE 事件直接驱动，按裁决着色 ----
  const evalData = useMemo(() => {
    const evs = stream.events.filter(
      (e) => e.event_type === "evaluation.completed" && e.payload?.primary?.value != null,
    );
    const timeBySeq = new Map(evs.map((e) => [e.seq, e.occurred_at.slice(11, 19)]));
    const val = (v: unknown) => Number(v);
    const byVerdict = (verdict: string) =>
      evs.filter((e) => e.payload.verdict === verdict).map((e) => ({ x: e.seq, y: val(e.payload.primary.value) }));
    const series: Series[] = [
      { name: "value", color: "var(--text4)", points: evs.map((e) => ({ x: e.seq, y: val(e.payload.primary.value) })), dashed: true },
      { name: "ELIGIBLE", color: "var(--accent)", points: byVerdict("ELIGIBLE"), line: false },
      { name: "INCONCLUSIVE", color: "var(--warn)", points: byVerdict("INCONCLUSIVE"), line: false },
      { name: "REJECTED", color: "var(--danger)", points: byVerdict("REJECTED"), line: false },
    ].filter((s) => s.points.length > 0);
    const markers: VMarker[] = stream.events
      .filter((e) => e.event_type === "optimizer.epoch_switched")
      .map((e) => ({ x: e.seq, label: `epoch ${e.payload?.next_epoch_index ?? e.payload?.epoch_index ?? "切换"}`, color: "var(--violet)" }));
    const metric = evs[0]?.payload?.primary?.metric ?? null;
    return { series, markers, metric, n: evs.length, timeBySeq };
  }, [stream.events]);

  // ---- 预算燃烧曲线：优化器运行累计花费 / 指标调用 ----
  const burnData = useMemo(() => {
    const sorted = [...runs].sort((a, b) => a.created_at.localeCompare(b.created_at));
    let cost = 0; let calls = 0;
    const costPts: { x: number; y: number }[] = [];
    const callPts: { x: number; y: number }[] = [];
    sorted.forEach((r, i) => {
      cost += Number(r.spent_usd) || 0;
      calls += Number(r.metric_calls) || 0;
      costPts.push({ x: i + 1, y: cost });
      callPts.push({ x: i + 1, y: calls });
    });
    return { costPts, callPts, totalCost: cost, totalCalls: calls };
  }, [runs]);

  const eligible = candidates.filter((c) => c.status === "ELIGIBLE" || c.status === "RELEASED").length;

  return (
    <div className="ws-body evo">
      {/* epoch 状态条 */}
      <div className="evo-head">
        <div className="evo-epoch">
          <span className="eyebrow">元演进 Epoch</span>
          {epoch ? (
            <span className="evo-epoch-line">
              <span className="mono num">#{epoch.index}</span>
              <span className="role-badge">{epoch.active_backend}</span>
              <span className={`state-chip ${epoch.status === "OPEN" ? "active" : epoch.status === "TRIAL_RUNNING" ? "evaluating" : ""}`}>
                {epoch.status}
              </span>
              {epoch.frozen && <span className="dim small">已冻结</span>}
            </span>
          ) : <span className="dim">尚无 epoch（首轮试炼后创建）</span>}
        </div>
        <button className="primary" onClick={startRound} disabled={starting} title="以当前活跃后端运行一轮等预算优化器试炼">
          {starting ? "派发中…" : "▶ 运行一轮优化"}
        </button>
      </div>
      {notice && <div className="evo-notice small">{notice}</div>}

      {/* 指标卡 */}
      <div className="stat-row">
        <StatCard label="候选" value={String(candidates.length)} hint={`${eligible} 个通过评测`} />
        <StatCard label="评测样本" value={String(evalData.n)} hint={evalData.metric ? `指标 ${evalData.metric}` : "尚无评测事件"} />
        <StatCard label="优化器累计花费" value={`$${burnData.totalCost.toFixed(4)}`} hint={`${runs.length} 次运行`} />
        <StatCard label="累计指标调用" value={String(burnData.totalCalls)} hint={anyRunning ? "● 有运行进行中" : undefined} />
      </div>

      {/* 评测曲线（实时） */}
      <div className="chart-card">
        <div className="chart-head">
          <span className="eyebrow">评测曲线 · primary value（SSE 实时）</span>
          <span className="chart-legend mono">
            <i style={{ background: "var(--accent)" }} />ELIGIBLE
            <i style={{ background: "var(--warn)" }} />INCONCLUSIVE
            <i style={{ background: "var(--danger)" }} />REJECTED
            <i className="violet" style={{ background: "var(--violet)" }} />epoch 切换
          </span>
        </div>
        <LineChart
          series={evalData.series}
          markers={evalData.markers}
          xFormat={(v) => evalData.timeBySeq.get(Math.round(v)) ?? ""}
          empty="尚无评测事件 —— 演进循环产生候选并评测后，此处实时绘制。"
          ariaLabel="评测 primary value 随时间的曲线"
        />
      </div>

      {/* 预算燃烧（小倍数） */}
      <div className="chart-grid">
        <div className="chart-card">
          <div className="chart-head"><span className="eyebrow">预算燃烧 · 累计 $</span></div>
          <LineChart
            series={[{ name: "cost", color: "var(--accent)", points: burnData.costPts, area: true }]}
            height={128}
            yFormat={(v) => `$${v.toFixed(3)}`}
            xFormat={(v) => `#${Math.round(v)}`}
            empty="尚无优化器运行"
            ariaLabel="优化器累计花费曲线"
          />
        </div>
        <div className="chart-card">
          <div className="chart-head"><span className="eyebrow">指标调用 · 累计</span></div>
          <LineChart
            series={[{ name: "calls", color: "var(--violet)", points: burnData.callPts, area: true }]}
            height={128}
            yFormat={(v) => v.toFixed(0)}
            xFormat={(v) => `#${Math.round(v)}`}
            empty="尚无优化器运行"
            ariaLabel="优化器累计指标调用曲线"
          />
        </div>
      </div>

      {/* 优化器运行记录 */}
      {runs.length > 0 && (
        <>
          <div className="eyebrow" style={{ marginTop: 14 }}>优化器运行</div>
          {runs.map((r) => (
            <div key={r.id} className={`run-row static opt-row ${r.status === "RUNNING" ? "running" : ""}`}>
              <span className={`state-chip ${r.status === "RUNNING" ? "evaluating" : r.status === "COMPLETED" ? "released" : r.status === "FAILED" ? "failed" : ""}`}>{r.status}</span>
              <span className="role-badge">{r.backend}</span>
              <span className="mono muted small">{r.mode}{r.epoch_index != null ? ` · epoch ${r.epoch_index}` : ""}</span>
              <span className="sa-title mono muted small">
                ${(Number(r.spent_usd) || 0).toFixed(4)} · {r.llm_calls} llm · {r.metric_calls} metric
                {r.stopped_reason ? ` · ${r.stopped_reason}` : ""}
              </span>
              <span className="mono dim small">{r.created_at.slice(5, 16).replace("T", " ")}</span>
              {r.status === "RUNNING" && <span className="pulse" aria-label="运行中" />}
            </div>
          ))}
          {runs.some((r) => r.reflection) && (
            <details className="raw-events" style={{ marginTop: 6 }}>
              <summary className="muted small">优化器反思（reflection，逐轮展开）</summary>
              {[...runs].sort((a, b) => b.created_at.localeCompare(a.created_at)).filter((r) => r.reflection).map((r) => (
                <div key={r.id} className="opt-reflection">
                  <div className="mono dim small">{r.created_at.slice(5, 16).replace("T", " ")} · {r.backend} · {r.status}</div>
                  <pre className="log mono">{r.reflection}</pre>
                </div>
              ))}
            </details>
          )}
        </>
      )}

      <ProblemPipeline goalId={goalId} stream={stream} />

      {/* 候选 */}
      <div className="eyebrow" style={{ marginTop: 14 }}>候选（内容寻址谱系）</div>
      {candidates.length === 0 && <div className="empty">暂无候选。演进循环会从真实失败生成候选。</div>}
      {candidates.map((c) => (
        <button key={c.id} className={`run-row cand`} onClick={() => onOpenInspector({ kind: "candidate", id: c.id })}>
          <span className={`state-chip ${c.status.toLowerCase()}`}>{c.status}</span>
          <span className="mono">{c.digest.slice(0, 8)}</span>
          <span className="sa-title">{c.title || c.kind}</span>
          <span className="mono muted">{(c.history ?? []).length} 状态记录</span>
        </button>
      ))}

      <ReleaseList goalId={goalId} stream={stream} userRole={userRole} onNotice={setNotice} />
    </div>
  );
}

/* 问题与提案：演进循环的输入端（真实失败 → 归因 → 最小补丁）。
   全部来自 /problems 与 /proposals 真实行。 */
function ProblemPipeline({ goalId, stream }: { goalId: string; stream: EventStreamState }) {
  const [problems, setProblems] = useState<ProblemRow[]>([]);
  const [proposals, setProposals] = useState<ProposalRow[]>([]);
  useEffect(() => {
    api.problems(goalId).then((r) => setProblems(r.problems)).catch(() => {});
    api.proposals(goalId).then((r) => setProposals(r.proposals)).catch(() => {});
  }, [goalId, stream.events.length]);
  if (!problems.length && !proposals.length) return null;
  return (
    <>
      <div className="eyebrow" style={{ marginTop: 14 }}>问题（失败归因）</div>
      {problems.map((p) => (
        <div key={p.id} className="run-row static" title={p.description}>
          <span className={`state-chip ${p.status === "OPEN" ? "evaluating" : "released"}`}>{p.status}</span>
          <span className="role-badge" data-role="Curator">{p.failure_class}</span>
          <span className="sa-title">{p.title}</span>
          <span className="mono dim small">{p.created_at.slice(5, 16).replace("T", " ")}</span>
        </div>
      ))}
      {proposals.length > 0 && <div className="eyebrow" style={{ marginTop: 12 }}>变更提案（机制 + 最小实验）</div>}
      {proposals.map((pr) => (
        <div key={pr.id} className="run-row static" title={`${pr.expected_effect}\n最小实验：${pr.min_experiment}\n回滚：${pr.rollback}`}>
          <span className={`state-chip ${pr.status === "PROPOSED" ? "evaluating" : "released"}`}>{pr.status}</span>
          <span className="sa-title">{pr.mechanism.slice(0, 90)}{(pr.mechanism.length ?? 0) > 90 ? "…" : ""}</span>
          <span className="mono muted small">{(pr.allowed_paths ?? []).join(", ")}</span>
          <span className="mono dim small">{pr.created_at.slice(5, 16).replace("T", " ")}</span>
        </div>
      ))}
    </>
  );
}

function ReleaseList({ goalId, stream, userRole, onNotice }: {
  goalId: string;
  stream: EventStreamState;
  userRole?: string;
  onNotice: (msg: string) => void;
}) {
  const [releases, setReleases] = useState<ReleaseRow[]>([]);
  const [pointers, setPointers] = useState<Pointer[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => {
    api.releases(goalId).then((r) => setReleases(r.releases)).catch(() => {});
    api.pointers().then((r) => setPointers(r.pointers)).catch(() => {});
  }, [goalId]);
  useEffect(() => { load(); }, [load, stream.events.length]);

  const rollback = useCallback(async (r: ReleaseRow) => {
    if (busy) return;
    if (!window.confirm(`回滚发布 ${r.id.slice(0, 12)}…？指针将切回父版本；已发生的外部副作用不会被撤销。`)) return;
    setBusy(r.id);
    try {
      await api.rollbackRelease(goalId, r.id, { scope: r.scope ?? undefined, reason: "operator rollback from workbench" });
      onNotice("回滚已执行：版本指针已切回父版本。");
      load();
    } catch (e) {
      onNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [busy, goalId, load, onNotice]);

  if (!releases.length && !pointers.length) return null;
  const canRollback = userRole === "admin";
  return (
    <>
      <div className="eyebrow" style={{ marginTop: 14 }}>发布与指针</div>
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
          <span className="mono muted">{r.kind} · {r.created_at.slice(5, 16).replace("T", " ")}</span>
          {canRollback && r.status !== "ROLLED_BACK" && (
            <button className="mini danger" disabled={busy === r.id} onClick={() => rollback(r)} title="将版本指针切回父版本（V26：admin-only）">
              {busy === r.id ? "回滚中…" : "回滚"}
            </button>
          )}
        </div>
      ))}
    </>
  );
}
