// GoalService: goal versions, planning (real LLM), commands (accepted≠applied),
// work-card projection, completion verification.
import { createHash } from "node:crypto";
import {
  newId, canTransition, GOAL_TRANSITIONS, TASK_TRANSITIONS, compileGraph,
  affectedSubgraph,
  type GraphContract, type CompiledGraph,
} from "@looplab/contracts";
import { EventStore } from "./eventstore.js";
import { BudgetService } from "./budget.js";
import { LlmGateway } from "./llmgateway.js";
import type { Db } from "./db.js";
import type { Config } from "./config.js";

const PLANNER_SYSTEM = `你是 LoopLab 平台的任务规划器。把用户目标分解为最小可执行任务图。
可用角色：Coordinator(协调/规划/诊断)、Researcher(调研)、Builder(实现)、Experimenter(实验)、Reviewer(独立审查)、Curator(沉淀)。
每个任务必须有明确可核验的交付物。允许声明有界循环（反思/重试），必须给 max_visits 和退出条件。
只输出 JSON，格式严格如下（不要加注释）：
{"nodes":[{"key":"t1","role":"Builder","kind":"model","title":"实现","instruction":"给执行角色的完整指令","depends_on":[],"risk_class":"low"}],"loops":[]}
kind 只能是 model|experiment|integration|review。3-6 个节点。指令要具体、可验证，禁止空话。`;

/** LLM outputs are data, not trusted contracts: normalize before validating. */
function normalizePlannedGraph(raw: any): unknown {
  if (!raw || typeof raw !== "object") return null;
  const nodes = Array.isArray(raw.nodes) ? raw.nodes.slice(0, 8) : [];
  const normNodes: any[] = [];
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    normNodes.push({
      key: String(n.key ?? `t${normNodes.length + 1}`).slice(0, 40),
      role: ["Coordinator", "Researcher", "Builder", "Experimenter", "Reviewer", "Curator"].includes(n.role) ? n.role : "Builder",
      kind: ["model", "experiment", "integration", "review"].includes(n.kind) ? n.kind : "model",
      title: String(n.title ?? "任务").slice(0, 120),
      instruction: String(n.instruction ?? "").slice(0, 4000),
      depends_on: Array.isArray(n.depends_on) ? n.depends_on.map(String).slice(0, 8) : [],
      input_refs: Array.isArray(n.input_refs) ? n.input_refs.map(String) : [],
      expected_output: n.expected_output ? String(n.expected_output).slice(0, 300) : null,
      risk_class: ["low", "medium", "high"].includes(n.risk_class) ? n.risk_class : "low",
    });
  }
  const normLoops: any[] = [];
  for (const l of Array.isArray(raw.loops) ? raw.loops : []) {
    const from = l?.back_edge?.from ?? l?.from;
    const to = l?.back_edge?.to ?? l?.to;
    if (!from || !to) continue;
    normLoops.push({
      back_edge: { from: String(from), to: String(to) },
      max_visits: Math.max(1, Math.min(Number(l.max_visits ?? 3) || 3, 10)),
      exit_condition: String(l.exit_condition ?? "验证通过或预算耗尽").slice(0, 200),
    });
  }
  if (!normNodes.length) return null;
  return { version: "", nodes: normNodes, loops: normLoops };
}

export interface WorkCard {
  goal_id: string;
  title: string;
  state: string;
  version: number;
  objective: string;
  doing: string | null;
  last_progress: string | null;
  waiting_reason: string | null;
  next_step: string | null;
  budget: { used: number; cap: number; outstanding: number; unknown: number };
  verified: { done: number; total: number; source: string } | null;
  graph_version: string | null;
  updated_at: string;
}

export class GoalService {
  private budget: BudgetService;
  private llm: LlmGateway;

  constructor(private db: Db, private config: Config) {
    this.budget = new BudgetService(db as any);
    this.llm = new LlmGateway(db, config);
  }

  async ensureDefaultProjects(userId: string) {
    const existing = await this.db.query("SELECT slug FROM projects WHERE owner_id=$1", [userId]);
    const have = new Set(existing.rows.map((r: any) => r.slug));
    for (const [slug, name] of [
      ["harness-improvement", "Harness 工具/上下文改进"],
      ["algorithm-search", "CPU 算法搜索"],
      ["computational-research", "计算型科研"],
    ] as const) {
      if (!have.has(slug)) {
        await this.db.query(
          "INSERT INTO projects (id, owner_id, slug, name) VALUES ($1,$2,$3,$4)",
          [newId("prj"), userId, slug, name],
        );
      }
    }
  }

  async createSession(userId: string, projectId: string, title: string): Promise<string> {
    const id = newId("ses");
    await this.db.query(
      "INSERT INTO chat_sessions (id, project_id, owner_id, title) VALUES ($1,$2,$3,$4)",
      [id, projectId, userId, title.slice(0, 80) || "新会话"],
    );
    return id;
  }

  /** User sends the first message of a session -> create goal + plan graph. */
  async createGoalFromMessage(input: {
    sessionId: string; userId: string; text: string; projectId: string;
    priority?: number;
  }): Promise<{ goalId: string; messageId: string; plan: string }> {
    const goalId = newId("goal");
    const messageId = newId("msg");
    const title = input.text.slice(0, 60);

    await this.db.tx(async (client) => {
      await client.query(
        `INSERT INTO goals (id, project_id, session_id, owner_id, title, state, priority)
         VALUES ($1,$2,$3,$4,$5,'DRAFT',$6)`,
        [goalId, input.projectId, input.sessionId, input.userId, title, input.priority ?? 5],
      );
      await client.query(
        `INSERT INTO goal_versions (goal_id, version, objective, created_by) VALUES ($1,1,$2,$3)`,
        [goalId, input.text, input.userId],
      );
      await client.query(
        `INSERT INTO messages (id, session_id, role, content) VALUES ($1,$2,'user',$3)`,
        [messageId, input.sessionId, input.text],
      );
      await client.query("UPDATE chat_sessions SET goal_id=$2, updated_at=now() WHERE id=$1", [input.sessionId, goalId]);
      await EventStore.append(client, {
        aggregateType: "goal", aggregateId: goalId, eventType: "goal.created",
        goalId, goalVersion: 1, actor: { kind: "user", id: input.userId },
        payload: { objective: input.text, session_id: input.sessionId },
        causationId: messageId,
      });
    });
    const plan = await this.planAndInstantiate(goalId, input.text, 1, input.userId);
    return { goalId, messageId, plan };
  }

  /**
   * Plan a graph with a real model call (NO persistence). Deterministic
   * single-node fallback when the planner fails/unparsable — honest, never fake.
   */
  private async planGraph(goalId: string, objective: string, version: number): Promise<{ graph: GraphContract; compiled: CompiledGraph; note: string }> {
    let parsed: GraphContract | null = null;
    let planNote = "";
    try {
      const result = await this.llm.call({
        goalId,
        scope: "task_execution",
        kind: "model",
        model: "chat",
        maxTokens: 1600,
        temperature: 0.2,
        idempotencyKey: `plan_${goalId}_v${version}`,
        actor: { kind: "agent", id: "planner" },
        messages: [
          { role: "system", content: PLANNER_SYSTEM },
          { role: "user", content: `目标：${objective}\n\n请输出任务图 JSON。` },
        ],
      });
      const text = result.message.content ?? "";
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const candidate = normalizePlannedGraph(JSON.parse(jsonMatch[0]));
        const compiled = candidate ? compileGraph(candidate) : { ok: false as const, errors: [{ code: "empty_graph" as const, message: "planner returned no nodes" }] };
        if (compiled.ok) {
          parsed = compiled.value.graph;
        } else {
          planNote = `规划图校验失败：${compiled.errors.map((e) => e.message).join("; ")}`;
        }
      }
    } catch (err) {
      planNote = `规划调用失败：${err instanceof Error ? err.message.slice(0, 120) : err}`;
    }
    if (!parsed) {
      // deterministic fallback: a single Coordinator task. Honest, never fake.
      parsed = {
        version: `${goalId}@${version}`,
        nodes: [{
          key: "t1",
          role: "Coordinator",
          kind: "model",
          title: `执行目标并产出可核验交付物`,
          instruction: `目标：${objective}\n\n1) 分解并执行该目标（可使用工作区文件与 Python）。2) 产出真实交付物文件。3) 给出结果摘要与验证方式。`,
          depends_on: [],
          input_refs: [],
          expected_output: "结果摘要 + 交付物 artifact",
          risk_class: "low",
        }],
        loops: [],
      };
      planNote = planNote || "使用单节点兜底规划";
    }
    const compiled = compileGraph(parsed);
    if (!compiled.ok) {
      throw new Error(`planned graph failed validation: ${compiled.errors.map((e) => e.message).join("; ").slice(0, 200)}`);
    }
    return { graph: parsed, compiled: compiled.value, note: planNote };
  }

  /** Plan a graph with a real model call, then materialize tasks. */
  async planAndInstantiate(goalId: string, objective: string, version: number, userId: string): Promise<string> {
    const { graph: parsed, note: planNote } = await this.planGraph(goalId, objective, version);

    const graphId = newId("graph");
    const digest = createHash("sha256").update(JSON.stringify(parsed)).digest("hex");
    await this.db.tx(async (client) => {
      await client.query(
        `INSERT INTO graph_versions (id, goal_id, version, nodes, loops, digest) VALUES ($1,$2,$3,$4,$5,$6)`,
        [graphId, goalId, version, JSON.stringify(parsed!.nodes), JSON.stringify(parsed!.loops), digest],
      );
      for (const n of parsed!.nodes) {
        await client.query(
          `INSERT INTO tasks (id, graph_version_id, goal_id, node_key, role, kind, title, instruction,
             depends_on, input_refs, expected_output, risk_class, state)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'READY')`,
          [newId("task"), graphId, goalId, n.key, n.role, n.kind, n.title, n.instruction,
            n.depends_on ?? [], JSON.stringify(n.input_refs ?? []),
            n.expected_output ?? null, n.risk_class ?? "low"],
        );
      }
      const goal = (await client.query("SELECT state FROM goals WHERE id=$1 FOR UPDATE", [goalId])).rows[0];
      const next = goal.state === "DRAFT" ? "ACTIVE" : goal.state;
      await client.query(
        "UPDATE goals SET current_version=$2, state=$3, updated_at=now(), row_version=row_version+1 WHERE id=$1",
        [goalId, version, next],
      );
      await EventStore.append(client, {
        aggregateType: "goal", aggregateId: goalId, eventType: "goal.graph_planned",
        goalId, goalVersion: version, actor: { kind: "agent", id: "planner" },
        payload: { graph_version_id: graphId, nodes: parsed!.nodes.map((n) => ({ key: n.key, role: n.role, title: n.title })), note: planNote },
      });
      if (next === "ACTIVE") {
        await EventStore.append(client, {
          aggregateType: "goal", aggregateId: goalId, eventType: "goal.activated",
          goalId, goalVersion: version, actor: { kind: "system", id: "goal-service" },
          payload: {},
        });
      }
    });
    return planNote;
  }

  // ---- commands ------------------------------------------------------------
  async applyCommand(input: {
    goalId: string; commandId: string; kind: string; payload: Record<string, unknown>;
    expectedRowVersion?: number | null; userId: string;
  }): Promise<{ status: "ACCEPTED" | "REJECTED"; applied: boolean; reason?: string }> {
    return this.db.tx(async (client) => {
      const dup = await client.query("SELECT * FROM commands WHERE command_id=$1", [input.commandId]);
      if (dup.rows[0]) {
        const c = dup.rows[0];
        return { status: c.status === "REJECTED" ? "REJECTED" : "ACCEPTED", applied: c.status === "APPLIED", reason: c.reject_reason ?? undefined };
      }
      const goal = (await client.query("SELECT * FROM goals WHERE id=$1 FOR UPDATE", [input.goalId])).rows[0];
      if (!goal) return { status: "REJECTED", applied: false, reason: "goal not found" };
      if (input.expectedRowVersion != null && Number(goal.row_version) !== input.expectedRowVersion) {
        await client.query(
          `INSERT INTO commands (id, command_id, goal_id, kind, status, reject_reason, actor)
           VALUES ($1,$2,$3,$4,'REJECTED','version_conflict',$5)`,
          [newId("cmd"), input.commandId, input.goalId, input.kind, JSON.stringify({ kind: "user", id: input.userId })],
        );
        return { status: "REJECTED", applied: false, reason: `version conflict: expected ${input.expectedRowVersion}, current ${goal.row_version}` };
      }

      let reason: string | undefined;
      let valid = true;
      switch (input.kind) {
        case "pause":
          if (!canTransition(GOAL_TRANSITIONS, goal.state, "PAUSED_USER")) {
            valid = false; reason = `cannot pause from ${goal.state}`;
          }
          break;
        case "resume":
          if (!canTransition(GOAL_TRANSITIONS, goal.state, "ACTIVE")) {
            valid = false; reason = `cannot resume from ${goal.state}`;
          }
          break;
        case "cancel":
          if (!canTransition(GOAL_TRANSITIONS, goal.state, "CANCELLED")) {
            valid = false; reason = `cannot cancel from ${goal.state}`;
          }
          break;
        case "steer":
          valid = ["ACTIVE", "WAITING_RESOURCE", "PAUSED_USER"].includes(goal.state);
          if (!valid) reason = `cannot steer from ${goal.state}`;
          break;
        case "revise":
          valid = ["ACTIVE", "PAUSED_USER", "WAITING_RESOURCE", "BLOCKED_INPUT"].includes(goal.state);
          if (!valid) reason = `cannot revise from ${goal.state}`;
          break;
        case "set_priority": {
          // ordering metadata, not a state transition: allowed from any state
          const p = input.payload.priority;
          valid = Number.isInteger(p) && (p as number) >= 1 && (p as number) <= 9;
          if (!valid) reason = `priority must be an integer 1..9, got ${JSON.stringify(p)}`;
          break;
        }
        default:
          valid = false; reason = `unknown command kind ${input.kind}`;
      }
      const cmdRowId = newId("cmd");
      if (!valid) {
        await client.query(
          `INSERT INTO commands (id, command_id, goal_id, kind, status, reject_reason, actor)
           VALUES ($1,$2,$3,$4,'REJECTED',$5,$6)`,
          [cmdRowId, input.commandId, input.goalId, input.kind, reason, JSON.stringify({ kind: "user", id: input.userId })],
        );
        return { status: "REJECTED", applied: false, reason };
      }
      await client.query(
        `INSERT INTO commands (id, command_id, goal_id, kind, payload, status, expected_row_version, actor)
         VALUES ($1,$2,$3,$4,$5,'ACCEPTED',$6,$7)`,
        [cmdRowId, input.commandId, input.goalId, input.kind, JSON.stringify(input.payload),
          input.expectedRowVersion ?? null, JSON.stringify({ kind: "user", id: input.userId })],
      );

      // apply synchronously where safe; commands are applied in this tx
      let applied = true;
      switch (input.kind) {
        case "pause":
          await client.query(
            `UPDATE goals SET state='PAUSED_USER', paused_reason='PAUSED_USER', updated_at=now(), row_version=row_version+1 WHERE id=$1`,
            [input.goalId],
          );
          await EventStore.append(client, {
            aggregateType: "goal", aggregateId: input.goalId, eventType: "goal.paused",
            goalId: input.goalId, actor: { kind: "user", id: input.userId }, causationId: input.commandId,
            payload: { note: "new dispatch stopped; running attempts drain" },
          });
          break;
        case "resume":
          await client.query(
            `UPDATE goals SET state='ACTIVE', paused_reason=NULL, updated_at=now(), row_version=row_version+1 WHERE id=$1`,
            [input.goalId],
          );
          await EventStore.append(client, {
            aggregateType: "goal", aggregateId: input.goalId, eventType: "goal.resumed",
            goalId: input.goalId, actor: { kind: "user", id: input.userId }, causationId: input.commandId,
          });
          break;
        case "cancel":
          await client.query(
            `UPDATE goals SET state='CANCELLED', paused_reason='CANCELLED', updated_at=now(), row_version=row_version+1 WHERE id=$1`,
            [input.goalId],
          );
          // cancel READY/WAITING tasks; running attempts drain via heartbeat
          await client.query(
            `UPDATE tasks SET state='CANCELLED', updated_at=now() WHERE goal_id=$1 AND state IN ('READY','WAITING')`,
            [input.goalId],
          );
          await EventStore.append(client, {
            aggregateType: "goal", aggregateId: input.goalId, eventType: "goal.cancelled",
            goalId: input.goalId, actor: { kind: "user", id: input.userId }, causationId: input.commandId,
            payload: { note: "external side effects already performed are NOT undone by this command" },
          });
          break;
        case "steer": {
          const steerId = newId("token");
          await client.query(
            `INSERT INTO steers (id, goal_id, content, created_by)
             SELECT $1, $2, $3, $4`,
            [steerId, input.goalId, String(input.payload.content ?? ""), input.userId],
          );
          // attach to running attempts of this goal
          await client.query(
            `UPDATE steers s SET attempt_id = a.id
               FROM attempts a
              WHERE s.id=$1 AND a.goal_id=$2 AND a.status IN ('LEASED','STARTED','RUNNING')`,
            [steerId, input.goalId],
          );
          await EventStore.append(client, {
            aggregateType: "goal", aggregateId: input.goalId, eventType: "goal.steer_accepted",
            goalId: input.goalId, actor: { kind: "user", id: input.userId }, causationId: input.commandId,
            payload: { steer_id: steerId, note: "applies at the next agent turn; does not interrupt the current tool" },
          });
          break;
        }
        case "revise":
          applied = false; // applied asynchronously by plan revision below
          break;
        case "set_priority": {
          const to = input.payload.priority as number;
          await client.query(
            `UPDATE goals SET priority=$2, updated_at=now(), row_version=row_version+1 WHERE id=$1`,
            [input.goalId, to],
          );
          await EventStore.append(client, {
            aggregateType: "goal", aggregateId: input.goalId, eventType: "goal.priority_changed",
            goalId: input.goalId, actor: { kind: "user", id: input.userId }, causationId: input.commandId,
            payload: { from: Number(goal.priority), to },
          });
          break;
        }
      }
      if (applied) {
        await client.query("UPDATE commands SET status='APPLIED', applied_at=now() WHERE id=$1", [cmdRowId]);
      }
      return { status: "ACCEPTED", applied, reason };
    });
  }

  /**
   * revise (§六.3): new goal version + graph, re-running ONLY the affected
   * subgraph (changed nodes + transitive successors) and KEEPING the valid
   * prefix — unaffected committed nodes are never re-run, unaffected live
   * tasks keep their frozen spec under the old graph version. `providedGraph`
   * (a user/agent-supplied edit) takes precedence over LLM re-planning and is
   * validated by compileGraph either way.
   */
  async applyRevision(goalId: string, newText: string, userId: string, providedGraph?: unknown): Promise<void> {
    const goal = (await this.db.query("SELECT * FROM goals WHERE id=$1", [goalId])).rows[0];
    if (!goal) throw new Error("goal not found");
    const nextVersion = goal.current_version + 1;

    // 1) obtain the new graph (explicit edit wins; else re-plan via LLM)
    let planned: { graph: GraphContract; compiled: CompiledGraph; note: string };
    if (providedGraph !== undefined) {
      const compiled = compileGraph(providedGraph);
      if (!compiled.ok) {
        throw new Error(`provided graph invalid: ${compiled.errors.map((e) => e.message).join("; ").slice(0, 300)}`);
      }
      planned = { graph: compiled.value.graph, compiled: compiled.value, note: "explicit graph edit (compile-validated)" };
    } else {
      planned = await this.planGraph(goalId, newText, nextVersion);
    }

    // 2) diff against the CURRENT graph: affected = changed/added node + all
    //    transitive successors (contract: affectedSubgraph)
    const oldRow = (await this.db.query(
      "SELECT nodes FROM graph_versions WHERE goal_id=$1 AND version=$2", [goalId, goal.current_version],
    )).rows[0];
    const oldSpecs = new Map<string, string>();
    for (const n of (oldRow?.nodes ?? []) as GraphContract["nodes"]) {
      oldSpecs.set(n.key, nodeFingerprint(n));
    }
    const changedRoots: string[] = [];
    for (const n of planned.graph.nodes) {
      const old = oldSpecs.get(n.key);
      if (old === undefined || old !== nodeFingerprint(n)) changedRoots.push(n.key);
    }
    const affected = new Set<string>();
    for (const root of changedRoots) {
      for (const k of affectedSubgraph(planned.compiled, root)) affected.add(k);
    }

    // 3) persist new version + re-instantiate ONLY affected nodes
    const graphId = newId("graph");
    const digest = createHash("sha256").update(JSON.stringify(planned.graph)).digest("hex");
    await this.db.tx(async (client) => {
      await client.query(
        `INSERT INTO goal_versions (goal_id, version, objective, created_by) VALUES ($1,$2,$3,$4)`,
        [goalId, nextVersion, newText, userId],
      );
      await client.query(
        "UPDATE goals SET title=$2, updated_at=now(), row_version=row_version+1 WHERE id=$1",
        [goalId, newText.slice(0, 60)],
      );
      await EventStore.append(client, {
        aggregateType: "goal", aggregateId: goalId, eventType: "goal.revised",
        goalId, goalVersion: nextVersion, actor: { kind: "user", id: userId },
        payload: {
          objective: newText, plan_note: planned.note,
          changed_roots: changedRoots,
          affected_nodes: [...affected],
        },
      });

      await client.query(
        `INSERT INTO graph_versions (id, goal_id, version, nodes, loops, digest) VALUES ($1,$2,$3,$4,$5,$6)`,
        [graphId, goalId, nextVersion, JSON.stringify(planned.graph.nodes), JSON.stringify(planned.graph.loops), digest],
      );

      // cancel stale live rows of AFFECTED nodes (in-flight attempts of any
      // state keep their frozen spec; their results produce no successors)
      let cancelled: string[] = [];
      if (affected.size > 0) {
        const stale = await client.query(
          `UPDATE tasks SET state='CANCELLED', updated_at=now()
            WHERE goal_id=$1 AND state IN ('READY','WAITING','FAILED')
              AND node_key = ANY($2) RETURNING node_key`,
          [goalId, [...affected]],
        );
        cancelled = stale.rows.map((r: any) => r.node_key);
      }

      // valid prefix = succeeded nodes NOT in the affected set: they keep
      // their SUCCEEDED rows and are NOT re-created (§六.3 保留有效前缀)
      const validPrefix = (await client.query(
        `SELECT DISTINCT node_key FROM tasks
          WHERE goal_id=$1 AND state='SUCCEEDED' AND NOT (node_key = ANY($2))`,
        [goalId, [...affected]],
      )).rows.map((r: any) => r.node_key);

      let created = 0;
      for (const n of planned.graph.nodes) {
        if (!affected.has(n.key)) continue; // unaffected: keep existing rows
        await client.query(
          `INSERT INTO tasks (id, graph_version_id, goal_id, node_key, role, kind, title, instruction,
             depends_on, input_refs, expected_output, risk_class, state)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'READY')`,
          [newId("task"), graphId, goalId, n.key, n.role, n.kind, n.title, n.instruction,
            n.depends_on ?? [], JSON.stringify(n.input_refs ?? []),
            n.expected_output ?? null, n.risk_class ?? "low"],
        );
        created++;
      }

      if (cancelled.length) {
        await EventStore.append(client, {
          aggregateType: "goal", aggregateId: goalId, eventType: "goal.graph_invalidated",
          goalId, goalVersion: goal.current_version,
          payload: { cancelled_tasks: cancelled, note: "only affected nodes invalidated; running attempts keep their frozen spec and produce no successors" },
        });
      }
      await EventStore.append(client, {
        aggregateType: "goal", aggregateId: goalId, eventType: "goal.graph_planned",
        goalId, goalVersion: nextVersion, actor: { kind: "agent", id: "planner" },
        payload: {
          graph_version_id: graphId, revision: true,
          nodes: planned.graph.nodes.map((n: any) => ({ key: n.key, role: n.role, title: n.title })),
          affected_nodes: [...affected], created_tasks: created,
          valid_prefix: validPrefix, note: planned.note,
        },
      });

      const g = (await client.query("SELECT state FROM goals WHERE id=$1 FOR UPDATE", [goalId])).rows[0];
      const next = g.state === "DRAFT" ? "ACTIVE" : g.state;
      await client.query(
        "UPDATE goals SET current_version=$2, state=$3, updated_at=now(), row_version=row_version+1 WHERE id=$1",
        [goalId, nextVersion, next],
      );
    });

    await this.db.query(
      `UPDATE commands SET status='APPLIED', applied_at=now()
        WHERE goal_id=$1 AND kind='revise' AND status='ACCEPTED'`,
      [goalId],
    );
  }

  // ---- projections ----------------------------------------------------------
  async workCard(goalId: string): Promise<WorkCard | null> {
    const goal = (await this.db.query(
      `SELECT g.*, gv.objective FROM goals g
         JOIN goal_versions gv ON gv.goal_id=g.id AND gv.version=g.current_version
        WHERE g.id=$1`, [goalId],
    )).rows[0];
    if (!goal) return null;
    const graph = (await this.db.query(
      "SELECT id, version FROM graph_versions WHERE goal_id=$1 ORDER BY version DESC LIMIT 1", [goalId],
    )).rows[0];
    const running = (await this.db.query(
      `SELECT t.title, a.id FROM attempts a JOIN tasks t ON t.id=a.task_id
        WHERE a.goal_id=$1 AND a.status IN ('LEASED','STARTED','RUNNING','RESULT_PENDING')
        ORDER BY a.created_at DESC LIMIT 1`, [goalId],
    )).rows[0];
    const progress = (await this.db.query(
      `SELECT payload->>'summary' AS s, occurred_at FROM events
        WHERE goal_id=$1 AND event_type IN ('attempt.committed','checkpoint.saved')
          AND payload->>'summary' IS NOT NULL
        ORDER BY seq DESC LIMIT 1`, [goalId],
    )).rows[0];
    const nextTask = (await this.db.query(
      `SELECT title FROM tasks WHERE goal_id=$1 AND state='READY' ORDER BY created_at LIMIT 1`, [goalId],
    )).rows[0];
    const budget = await this.budget.snapshot((this.db.pool as any), goalId);
    const counts = (await this.db.query(
      `SELECT count(*) FILTER (WHERE state='SUCCEEDED') AS done, count(*) AS total
         FROM tasks WHERE graph_version_id=$1`, [graph?.id],
    )).rows[0];

    return {
      goal_id: goalId,
      title: goal.title,
      state: goal.state,
      version: goal.current_version,
      objective: goal.objective,
      doing: running ? running.title : null,
      last_progress: progress?.s ?? null,
      waiting_reason:
        goal.state === "PAUSED_USER" ? "PAUSED_USER" :
        goal.state === "WAITING_RESOURCE" ? "WAITING_RESOURCE" :
        goal.state === "BLOCKED_INPUT" ? "BLOCKED_INPUT" : null,
      next_step: nextTask?.title ?? null,
      budget: {
        used: Number(Number(budget.settled).toFixed(4)),
        cap: Number(budget.cap),
        outstanding: Number(Number(budget.outstanding).toFixed(4)),
        unknown: Number(Number(budget.unknown).toFixed(4)),
      },
      // fixed-contract batch: verified/total only when a graph exists
      verified: graph && counts ? { done: Number(counts.done), total: Number(counts.total), source: `graph:${graph.id}` } : null,
      graph_version: graph ? `${goalId}@${graph.version}` : null,
      updated_at: goal.updated_at?.toISOString?.() ?? String(goal.updated_at),
    };
  }

  /** Called after an attempt commits (from attempts route). */
  async onAttemptCommitted(client: any, attempt: any, outcome: "SUCCEEDED" | "FAILED", summary: string, verification: { passed: boolean; detail: string } | null): Promise<void> {
    const task = (await client.query("SELECT * FROM tasks WHERE id=$1 FOR UPDATE", [attempt.task_id])).rows[0];
    if (!task) return;
    const newTaskState = task.state === "CANCELLED" ? "CANCELLED"
      : outcome === "SUCCEEDED" ? "SUCCEEDED" : "FAILED";
    if (canTransition(TASK_TRANSITIONS, task.state, newTaskState)) {
      const fingerprint = outcome === "FAILED"
        ? `attempt_error:${task.node_key}:${attempt.error_class ?? "unknown"}`
        : task.error_fingerprint;
      await client.query(
        `UPDATE tasks SET state=$2, updated_at=now(),
           failure_count = CASE WHEN $2='FAILED' THEN failure_count+1 ELSE failure_count END,
           error_fingerprint = COALESCE($3, error_fingerprint)
         WHERE id=$1`,
        [task.id, newTaskState, fingerprint ?? null],
      );
      // A13: 3 identical fingerprints -> park the task and dispatch diagnosis
      if (newTaskState === "FAILED" && task.failure_count + 1 >= 3) {
        await client.query("UPDATE tasks SET state='WAITING' WHERE id=$1", [task.id]);
        const diagId = newId("task");
        await client.query(
          `INSERT INTO tasks (id, graph_version_id, goal_id, node_key, role, kind, title, instruction, risk_class, state)
           VALUES ($1,$2,$3,$4,'Coordinator','integration',$5,$6,'low','READY')`,
          [diagId, task.graph_version_id, attempt.goal_id,
            `diagnose_${task.node_key}_${Date.now()}`,
            `诊断重复失败: ${task.title}`,
            `任务「${task.title}」已以相同错误失败 ${task.failure_count + 1} 次（${attempt.error_class ?? "unknown"}）。请分析根因并产出修复建议或放弃建议。禁止原样重试。`],
        );
        await EventStore.append(client, {
          aggregateType: "task", aggregateId: task.id, eventType: "task.retry_loop_diagnosed",
          goalId: attempt.goal_id, actor: { kind: "system", id: "supervisor" },
          payload: { failure_count: task.failure_count + 1, diagnosis_task: diagId },
        });
      }
    }
    await EventStore.append(client, {
      aggregateType: "task", aggregateId: task.id, eventType: newTaskState === "SUCCEEDED" ? "task.succeeded" : "task.failed",
      goalId: attempt.goal_id, leaseEpoch: attempt.lease_epoch,
      payload: { attempt_id: attempt.id, summary: summary.slice(0, 500), outcome },
    });
    if (newTaskState !== "SUCCEEDED") return;

    // graph complete? -> create independent Reviewer verification task
    const graph = (await client.query(
      `SELECT g.* FROM graph_versions g WHERE g.id=$1`, [task.graph_version_id],
    )).rows[0];
    const remaining = (await client.query(
      `SELECT count(*)::int AS n FROM tasks
        WHERE graph_version_id=$1 AND state NOT IN ('SUCCEEDED','CANCELLED') AND id <> $2`,
      [task.graph_version_id, task.id],
    )).rows[0].n;
    const isVerifyTask = task.node_key.startsWith("verify_");
    if (remaining === 0 && !isVerifyTask) {
      await this.createVerificationTask(client, graph, attempt);
    }
    if (isVerifyTask) {
      const passed = verification?.passed === true;
      await client.query(
        `UPDATE goals SET state=$2, paused_reason=$3, updated_at=now(), row_version=row_version+1 WHERE id=$1 AND state <> 'CANCELLED'`,
        [attempt.goal_id, passed ? "COMPLETED" : "BLOCKED_INPUT", passed ? null : "verification_failed_needs_input"],
      );
      await EventStore.append(client, {
        aggregateType: "goal", aggregateId: attempt.goal_id,
        eventType: passed ? "goal.completed" : "goal.verification_failed",
        goalId: attempt.goal_id,
        payload: { detail: verification?.detail ?? summary.slice(0, 300) },
      });
    }
  }

  private async createVerificationTask(client: any, graph: any, attempt: any) {
    const goalVersion = (await client.query(
      "SELECT current_version FROM goals WHERE id=$1", [attempt.goal_id],
    )).rows[0].current_version;
    const objective = (await client.query(
      "SELECT objective FROM goal_versions WHERE goal_id=$1 AND version=$2", [attempt.goal_id, goalVersion],
    )).rows[0].objective;
    const id = newId("task");
    await client.query(
      `INSERT INTO tasks (id, graph_version_id, goal_id, node_key, role, kind, title, instruction, risk_class, state)
       VALUES ($1,$2,$3,$4,'Reviewer','review',$5,$6,'low','READY')`,
      [id, graph.id, attempt.goal_id, `verify_${Date.now()}`,
        `独立完成审查：${objective.slice(0, 40)}`,
        `你是独立 Reviewer。目标为：「${objective}」。请检查工作区中的交付物文件（workspace_list / workspace_read），核对是否真实完成了目标且无越权行为。
结束时按平台约定输出 RESULT + 单行 JSON，verification 字段填：{"kind":"verdict","passed":true或false,"detail":"审查原因"}。你的判定会被独立记录，不要迎合。`],
    );
    await EventStore.append(client, {
      aggregateType: "goal", aggregateId: attempt.goal_id, eventType: "completion.claimed",
      goalId: attempt.goal_id,
      payload: { verify_task: id, note: "all graph tasks succeeded; independent verification dispatched" },
    });
  }

  /** WAITING_RESOURCE -> ACTIVE when budget headroom exists again. */
  async autoResumeFromWaiting(goalId: string): Promise<boolean> {
    return this.db.tx(async (client) => {
      const goal = (await client.query("SELECT * FROM goals WHERE id=$1 FOR UPDATE", [goalId])).rows[0];
      if (!goal || goal.state !== "WAITING_RESOURCE") return false;
      const snap = await this.budget.snapshot(client, goalId);
      if (snap.available < 0.001) return false;
      await client.query(
        `UPDATE goals SET state='ACTIVE', paused_reason=NULL, updated_at=now(), row_version=row_version+1 WHERE id=$1`,
        [goalId],
      );
      await EventStore.append(client, {
        aggregateType: "goal", aggregateId: goalId, eventType: "goal.resumed",
        goalId, actor: { kind: "system", id: "budget-watch" },
        payload: { note: "budget headroom restored within the same authorization" },
      });
      return true;
    });
  }
}

/** Stable spec fingerprint for revision diffing (§六.3 changed-node detection). */
function nodeFingerprint(n: GraphContract["nodes"][number]): string {
  const spec = {
    role: n.role, kind: n.kind, title: n.title, instruction: n.instruction,
    depends_on: [...(n.depends_on ?? [])].sort(), input_refs: n.input_refs ?? [],
    expected_output: n.expected_output ?? null, risk_class: n.risk_class ?? "low",
  };
  return createHash("sha256").update(JSON.stringify(spec)).digest("hex");
}
