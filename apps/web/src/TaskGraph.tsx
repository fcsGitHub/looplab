import { useMemo } from "react";
import type { Task } from "./api";

/* 任务 DAG：按拓扑深度分列的 SVG 有向图。
   节点着色 = 状态，徽标点 = 角色；边带箭头，指向运行中节点的边高亮。 */

const NW = 168; const NH = 44; const GX = 56; const GY = 14;

export function TaskGraph({ tasks, onOpen }: { tasks: Task[]; onOpen: (taskId: string) => void }) {
  const model = useMemo(() => {
    if (!tasks.length) return null;
    const byKey = new Map(tasks.map((t) => [t.node_key, t]));
    // 拓扑深度（最长路），防御循环：每节点最多解析 tasks.length 次
    const depth = new Map<string, number>();
    const resolving = new Set<string>();
    const depthOf = (t: Task, fuel: number): number => {
      if (depth.has(t.node_key)) return depth.get(t.node_key)!;
      if (fuel <= 0 || resolving.has(t.node_key)) return 0;
      resolving.add(t.node_key);
      const deps = (t.depends_on ?? []).map((k) => byKey.get(k)).filter((d): d is Task => !!d);
      const d = deps.length ? 1 + Math.max(...deps.map((x) => depthOf(x, fuel - 1))) : 0;
      resolving.delete(t.node_key);
      depth.set(t.node_key, d);
      return d;
    };
    tasks.forEach((t) => depthOf(t, tasks.length));
    const cols = new Map<number, Task[]>();
    for (const t of tasks) {
      const d = depth.get(t.node_key) ?? 0;
      cols.set(d, [...(cols.get(d) ?? []), t]);
    }
    const pos = new Map<string, { x: number; y: number }>();
    let maxRows = 0;
    for (const [d, col] of cols) {
      maxRows = Math.max(maxRows, col.length);
      col.forEach((t, i) => pos.set(t.node_key, { x: d * (NW + GX) + 8, y: i * (NH + GY) + 8 }));
    }
    const nCols = Math.max(...cols.keys()) + 1;
    const edges: { x1: number; y1: number; x2: number; y2: number; hot: boolean; done: boolean; key: string }[] = [];
    for (const t of tasks) {
      const p2 = pos.get(t.node_key)!;
      for (const dk of t.depends_on ?? []) {
        const dep = byKey.get(dk);
        if (!dep) continue;
        const p1 = pos.get(dk)!;
        edges.push({
          x1: p1.x + NW, y1: p1.y + NH / 2, x2: p2.x, y2: p2.y + NH / 2,
          hot: t.state === "RUNNING" || dep.state === "RUNNING",
          done: dep.state === "SUCCEEDED",
          key: `${dk}->${t.node_key}`,
        });
      }
    }
    return { pos, edges, w: nCols * (NW + GX) - GX + 16, h: maxRows * (NH + GY) - GY + 16 };
  }, [tasks]);

  if (!model) return null;

  return (
    <div className="dag-wrap" role="img" aria-label="任务依赖图">
      <svg width={model.w} height={model.h} className="dag">
        <defs>
          <marker id="dag-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L8,4 L0,8 z" className="dag-arrow-fill" />
          </marker>
        </defs>
        {model.edges.map((e) => {
          const mx = (e.x1 + e.x2) / 2;
          return (
            <path
              key={e.key}
              d={`M ${e.x1} ${e.y1} C ${mx} ${e.y1}, ${mx} ${e.y2}, ${e.x2} ${e.y2}`}
              className={`dag-edge ${e.hot ? "hot" : ""} ${e.done ? "done" : ""}`}
              markerEnd="url(#dag-arrow)"
            />
          );
        })}
        {tasks.map((t) => {
          const p = model.pos.get(t.node_key)!;
          return (
            <g
              key={t.id}
              className={`dag-node state-${t.state.toLowerCase()}`}
              transform={`translate(${p.x},${p.y})`}
              onClick={() => onOpen(t.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") onOpen(t.id); }}
              aria-label={`${t.node_key} ${t.title} ${t.state}`}
            >
              <rect width={NW} height={NH} rx="8" className="dag-node-rect" />
              <circle cx="12" cy="13" r="3" className={`dag-role-dot role-${t.role.toLowerCase()}`} />
              <text x="21" y="16.5" className="dag-key mono">{t.node_key}</text>
              <text x={NW - 8} y="16.5" textAnchor="end" className="dag-state mono">{t.state}</text>
              <text x="12" y="34" className="dag-title">{truncate(t.title, 22)}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
