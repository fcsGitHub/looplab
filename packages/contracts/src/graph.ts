// LoopLab contracts: graph compiler (design §7.2).
// A graph is executable only if: no cycles outside declared loops, every loop
// back-edge has a bounded revisit limit + exit condition, all edges reference
// existing nodes, the graph is reachable from the entry set, and roles are
// from the six allowed roles (already enforced by the zod schema).

import { GraphContractSchema, type GraphContract, type TaskNode } from "./schema.js";

export interface GraphCompileError {
  code:
    | "unknown_node"
    | "unreachable_node"
    | "undeclared_cycle"
    | "unbounded_loop"
    | "missing_exit_condition"
    | "empty_graph"
    | "self_loop";
  message: string;
  node?: string;
}

export interface CompiledGraph {
  graph: GraphContract;
  entryNodes: string[];
  /** topo order of the DAG part; loop nodes are ordered by first visit */
  topoOrder: string[];
  /** successors per node (for "rerun affected node + successors") */
  successors: Record<string, string[]>;
  visitCaps: Record<string, Record<string, number>>;
}

export function compileGraph(input: unknown): { ok: true; value: CompiledGraph } | { ok: false; errors: GraphCompileError[] } {
  const parsed = GraphContractSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => ({ code: "unknown_node" as const, message: `${i.path.join(".")}: ${i.message}` })) };
  }
  const graph = parsed.data;
  const errors: GraphCompileError[] = [];
  const nodeKeys = new Set(graph.nodes.map((n) => n.key));

  if (graph.nodes.length === 0) {
    errors.push({ code: "empty_graph", message: "graph has no nodes" });
  }

  // edge targets must exist
  for (const n of graph.nodes) {
    for (const dep of n.depends_on) {
      if (!nodeKeys.has(dep)) {
        errors.push({ code: "unknown_node", message: `node "${n.key}" depends on unknown node "${dep}"`, node: n.key });
      }
    }
  }

  // self loops are meaningless
  for (const n of graph.nodes) {
    if (n.depends_on.includes(n.key)) {
      errors.push({ code: "self_loop", message: `node "${n.key}" depends on itself`, node: n.key });
    }
  }

  // find cycles (excluding declared loop back-edges)
  const declaredLoops = new Set(graph.loops.map((l) => `${l.back_edge.to}=>${l.back_edge.from}`));
  const adj = new Map<string, string[]>();
  for (const n of graph.nodes) {
    // edge dep -> node (dependency flows forward)
    for (const dep of n.depends_on) {
      if (declaredLoops.has(`${dep}=>${n.key}`)) continue; // declared back edge
      adj.set(dep, [...(adj.get(dep) ?? []), n.key]);
    }
  }
  const cycles = findCycles(graph.nodes.map((n) => n.key), adj);
  for (const cyc of cycles) {
    errors.push({
      code: "undeclared_cycle",
      message: `cycle ${cyc.join(" -> ")} not declared in loops[]`,
      node: cyc[0],
    });
  }

  // declared loops must be bounded with exit condition
  for (const l of graph.loops) {
    if (!nodeKeys.has(l.back_edge.from) || !nodeKeys.has(l.back_edge.to)) {
      errors.push({ code: "unknown_node", message: `loop references unknown nodes`, node: l.back_edge.from });
    }
    if (!l.max_visits || l.max_visits < 1) {
      errors.push({ code: "unbounded_loop", message: `loop ${l.back_edge.to}=>${l.back_edge.from} lacks positive max_visits`, node: l.back_edge.to });
    }
    if (!l.exit_condition || l.exit_condition.trim() === "") {
      errors.push({ code: "missing_exit_condition", message: `loop ${l.back_edge.to}=>${l.back_edge.from} lacks exit_condition`, node: l.back_edge.to });
    }
  }

  // reachability: nodes with no (non-loop) dependencies are entries
  const allAdj = new Map<string, string[]>();
  for (const n of graph.nodes) {
    for (const dep of n.depends_on) {
      allAdj.set(dep, [...(allAdj.get(dep) ?? []), n.key]);
    }
  }
  const entry = graph.nodes.filter((n) => n.depends_on.length === 0).map((n) => n.key);
  const reachable = new Set<string>();
  const stack = [...entry];
  while (stack.length) {
    const cur = stack.pop()!;
    if (reachable.has(cur)) continue;
    reachable.add(cur);
    for (const next of allAdj.get(cur) ?? []) stack.push(next);
  }
  for (const n of graph.nodes) {
    if (!reachable.has(n.key)) {
      errors.push({ code: "unreachable_node", message: `node "${n.key}" is unreachable`, node: n.key });
    }
  }

  if (errors.length) return { ok: false, errors };

  const topoOrder = topoSort(graph.nodes, adj);
  const successors: Record<string, string[]> = {};
  for (const n of graph.nodes) {
    successors[n.key] = allAdj.get(n.key) ?? [];
  }
  const visitCaps: Record<string, Record<string, number>> = {};
  for (const l of graph.loops) {
    visitCaps[l.back_edge.to] = { ...(visitCaps[l.back_edge.to] ?? {}), [l.back_edge.from]: l.max_visits };
  }

  return { ok: true, value: { graph, entryNodes: entry, topoOrder, successors, visitCaps } };
}

/** Affected set = node itself + all transitive successors (design 六.3). */
export function affectedSubgraph(compiled: CompiledGraph, failedNode: string): Set<string> {
  const affected = new Set<string>();
  const stack = [failedNode];
  while (stack.length) {
    const cur = stack.pop()!;
    if (affected.has(cur)) continue;
    affected.add(cur);
    for (const next of compiled.successors[cur] ?? []) stack.push(next);
  }
  return affected;
}

function findCycles(nodes: string[], adj: Map<string, string[]>): string[][] {
  // Tarjan SCC, report SCCs of size > 1 as cycles
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  let counter = 0;

  const strongconnect = (v: string) => {
    index.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!index.has(w)) {
        strongconnect(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      if (scc.length > 1) cycles.push(scc);
    }
  };

  for (const v of nodes) if (!index.has(v)) strongconnect(v);
  return cycles;
}

function topoSort(nodes: TaskNode[], adj: Map<string, string[]>): string[] {
  const indeg = new Map<string, number>(nodes.map((n) => [n.key, 0]));
  for (const [from, tos] of adj) {
    for (const to of tos) indeg.set(to, (indeg.get(to) ?? 0) + 1);
  }
  const order: string[] = [];
  const queue = nodes.filter((n) => (indeg.get(n.key) ?? 0) === 0).map((n) => n.key);
  while (queue.length) {
    const cur = queue.shift()!;
    order.push(cur);
    for (const to of adj.get(cur) ?? []) {
      const d = (indeg.get(to) ?? 1) - 1;
      indeg.set(to, d);
      if (d === 0) queue.push(to);
    }
  }
  return order;
}
