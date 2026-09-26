// All HTTP routes. Handlers stay thin; logic lives in services.
import type { FastifyInstance, FastifyReply } from "fastify";
import { spawn } from "node:child_process";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { EventStore } from "../eventstore.js";
import { AuthService, SESSION_COOKIE } from "../auth.js";
import { BudgetExceededError } from "../budget.js";
import { FencingError } from "../attempts.js";
import { OptimizerAuthError, OptimizerBudgetExceededError } from "../optimizer.js";
import { ReleaseConflictError, ReleaseBlockedError } from "../releases.js";
import { RateLimiter } from "../ratelimit.js";
import { infraEnv } from "../childenv.js";
import type { ControlServices } from "./services.js";

export function registerRoutes(app: FastifyInstance, svc: ControlServices) {
  const requireAuth = async (req: any, reply: FastifyReply) => {
    const user = await svc.auth.userFromRequest(req);
    if (!user) {
      await reply.code(401).send({ error: "unauthenticated" });
      return false;
    }
    req.user = user;
    return true;
  };

  // ---- worker-plane transport auth (P17) ------------------------------------
  // The control service binds 0.0.0.0; fencing tokens alone only separate
  // workers from each other, they do not stop a LAN peer from IMPERSONATING
  // one (claim → drive model spend / fake commits). When WORKER_TOKEN is
  // configured, every worker-plane request must carry it. Empty config keeps
  // the legacy open behavior for local dev (loudly warned at boot).
  const workerTokenHash = svc.config.workerToken
    ? createHash("sha256").update(svc.config.workerToken).digest()
    : null;
  const requireWorkerToken = async (req: any, reply: FastifyReply) => {
    if (!workerTokenHash) return true;
    const provided = String(req.headers["x-worker-token"] ?? "");
    const providedHash = createHash("sha256").update(provided).digest();
    if (providedHash.length === workerTokenHash.length && timingSafeEqual(providedHash, workerTokenHash)) {
      return true;
    }
    await reply.code(401).send({ error: "worker token required" });
    return false;
  };

  // credential-stuffing brake: per-IP+username sliding window, lockout after
  // repeated failures (P17; brute force on scrypt was previously unthrottled)
  const authLimiter = new RateLimiter(10 * 60_000, 8, 15 * 60_000);
  // planner throttle (P22): a session's FIRST message dispatches a real
  // planning LLM call — unthrottled, one account could spin up arbitrary
  // metered spend. 5 planning dispatches per 10 min per user; steering
  // messages to existing goals are not metered by this.
  const plannerLimiter = new RateLimiter(10 * 60_000, 5, 60_000); // 5 dispatches/10min, then a 60s cooldown

  // ---- goal/attempt isolation (P17) ------------------------------------------
  // Reads used to be scoped only by knowledge of the id. Goals carry owner_id;
  // members now only see their own goals (404 — existence is not revealed),
  // admins see everything. Returns null after replying when access is denied.
  const goalScope = async (req: any, reply: FastifyReply, goalId: string): Promise<{ id: string } | null> => {
    const row = (await svc.db.query("SELECT id, owner_id FROM goals WHERE id=$1", [goalId])).rows[0] as { id: string; owner_id: string } | undefined;
    if (!row || (req.user!.role !== "admin" && row.owner_id !== req.user!.id)) {
      reply.code(404).send({ error: "goal not found" });
      return null;
    }
    return row;
  };
  const attemptScope = async (req: any, reply: FastifyReply, attemptId: string): Promise<{ id: string; goal_id: string } | null> => {
    const row = (await svc.db.query(
      `SELECT a.id, a.goal_id, g.owner_id FROM attempts a JOIN goals g ON g.id=a.goal_id WHERE a.id=$1`,
      [attemptId],
    )).rows[0] as { id: string; goal_id: string; owner_id: string } | undefined;
    if (!row || (req.user!.role !== "admin" && row.owner_id !== req.user!.id)) {
      reply.code(404).send({ error: "attempt not found" });
      return null;
    }
    return row;
  };

  // ---- auth ----------------------------------------------------------------
  app.post("/v1/auth/register", async (req, reply) => {
    const rlKey = `reg:${req.ip}`;
    if (!authLimiter.check(rlKey).allowed) {
      return reply.code(429).send({ error: "too many attempts, try later" });
    }
    const { username, password } = req.body as any;
    if (!username || !password || String(password).length < 4) {
      return reply.code(400).send({ error: "username and password(>=4 chars) required" });
    }
    try {
      const user = await svc.auth.register(String(username), String(password));
      const session = await svc.auth.login(String(username), String(password));
      if (session) svc.auth.setCookie(reply, session.token);
      await svc.goals.ensureDefaultProjects(user.id);
      authLimiter.reset(rlKey);
      return { user };
    } catch (err: any) {
      if (String(err?.message ?? "").includes("duplicate key")) {
        authLimiter.fail(rlKey);
        return reply.code(409).send({ error: "username taken" });
      }
      throw err;
    }
  });

  app.post("/v1/auth/login", async (req, reply) => {
    const { username, password } = req.body as any;
    const rlKey = `login:${req.ip}:${String(username ?? "").slice(0, 64)}`;
    if (!authLimiter.check(rlKey).allowed) {
      return reply.code(429).send({ error: "too many failed attempts, try later" });
    }
    const session = await svc.auth.login(String(username ?? ""), String(password ?? ""));
    if (!session) {
      authLimiter.fail(rlKey);
      return reply.code(401).send({ error: "invalid credentials" });
    }
    authLimiter.reset(rlKey);
    svc.auth.setCookie(reply, session.token);
    await svc.goals.ensureDefaultProjects(session.userId);
    const u = await svc.db.query("SELECT id, username, role FROM users WHERE id=$1", [session.userId]);
    return { user: u.rows[0] };
  });

  app.post("/v1/auth/logout", async (req, reply) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) await svc.auth.logout(token);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/v1/me", async (req, reply) => {
    if (!(await requireAuth(req, reply))) return;
    return { user: req.user };
  });

  // ---- projects & sessions ---------------------------------------------------
  app.get("/v1/projects", async (req, reply) => {
    if (!(await requireAuth(req, reply))) return;
    return { projects: (await svc.db.query("SELECT * FROM projects WHERE owner_id=$1 ORDER BY created_at", [req.user!.id])).rows };
  });

  app.post("/v1/projects", async (req, reply) => {
    if (!(await requireAuth(req, reply))) return;
    const { name, slug } = req.body as any;
    const id = `prj_${randomBytes(8).toString("hex")}`;
    await svc.db.query(
      "INSERT INTO projects (id, owner_id, slug, name) VALUES ($1,$2,$3,$4)",
      [id, req.user!.id, String(slug ?? name).toLowerCase().replace(/\s+/g, "-").slice(0, 40), String(name)],
    );
    return { id };
  });

  app.get("/v1/sessions", async (req, reply) => {
    if (!(await requireAuth(req, reply))) return;
    const projectId = (req.query as any).project_id;
    const rows = await svc.db.query(
      `SELECT s.*, g.state AS goal_state FROM chat_sessions s
         LEFT JOIN goals g ON g.id = s.goal_id
        WHERE s.owner_id=$1 AND ($2::text IS NULL OR s.project_id=$2)
        ORDER BY s.updated_at DESC LIMIT 100`,
      [req.user!.id, projectId ?? null],
    );
    return { sessions: rows.rows };
  });

  app.post("/v1/sessions", async (req, reply) => {
    if (!(await requireAuth(req, reply))) return;
    const { project_id, title } = req.body as any;
    const id = await svc.goals.createSession(req.user!.id, String(project_id), String(title ?? "新会话"));
    return { id };
  });

  app.get("/v1/sessions/:id/messages", async (req, reply) => {
    if (!(await requireAuth(req, reply))) return;
    // ownership check: the session id alone used to be enough to read another
    // user's conversation (IDOR, P17)
    const sess = (await svc.db.query(
      "SELECT id FROM chat_sessions WHERE id=$1 AND owner_id=$2",
      [(req.params as any).id, req.user!.id],
    )).rows[0];
    if (!sess) return reply.code(404).send({ error: "session not found" });
    const rows = await svc.db.query(
      "SELECT * FROM messages WHERE session_id=$1 ORDER BY seq ASC LIMIT 500",
      [sess.id],
    );
    return { messages: rows.rows };
  });

  /**
   * Send a chat message. First message creates the goal (real planning call);
   * subsequent messages steer the active goal (accepted ≠ applied).
   */
  app.post("/v1/sessions/:id/messages", async (req, reply) => {
    if (!(await requireAuth(req, reply))) return;
    const { content, priority } = req.body as any;
    if (!content || !String(content).trim()) return reply.code(400).send({ error: "empty message" });
    if (priority !== undefined && (!Number.isInteger(priority) || priority < 1 || priority > 9)) {
      return reply.code(400).send({ error: "priority must be an integer 1..9 (1 = most urgent)" });
    }
    const session = (await svc.db.query("SELECT * FROM chat_sessions WHERE id=$1 AND owner_id=$2", [(req.params as any).id, req.user!.id])).rows[0];
    if (!session) return reply.code(404).send({ error: "session not found" });

    if (!session.goal_id) {
      const plannerSlot = `plan:${req.user!.id}`;
      if (!plannerLimiter.check(plannerSlot).allowed) {
        return reply.code(429).send({ error: "goal creation rate limit reached, try later" });
      }
      plannerLimiter.fail(plannerSlot); // consume a slot for this dispatch
      const out = await svc.goals.createGoalFromMessage({
        sessionId: session.id, userId: req.user!.id, text: String(content), projectId: session.project_id,
        priority,
      });
      return reply.code(202).send({
        message_id: out.messageId, goal_id: out.goalId, note: "goal created; graph planning dispatched", plan_note: out.plan,
      });
    }
    // steer the existing goal
    const receipt = await svc.goals.applyCommand({
      goalId: session.goal_id, commandId: `cmd_${randomBytes(8).toString("hex")}`,
      kind: "steer", payload: { content: String(content) }, userId: req.user!.id,
    });
    await svc.db.query(
      "INSERT INTO messages (id, session_id, role, content) VALUES ($1,$2,'user',$3)",
      [`msg_${randomBytes(8).toString("hex")}`, session.id, String(content)],
    );
    return reply.code(202).send({ goal_id: session.goal_id, ...receipt });
  });

  // ---- goals -----------------------------------------------------------------
  app.get("/v1/goals", async (req, reply) => {
    if (!(await requireAuth(req, reply))) return;
    // goal list with ownership scoping (admin sees all) — supports overview
    // dashboards and programmatic consumers
    const q = req.query as any;
    const state = typeof q.state === "string" && q.state ? q.state : null;
    const search = typeof q.q === "string" && q.q.trim() ? `%${q.q.trim()}%` : null;
    const limit = Math.min(Math.max(Number(q.limit ?? 50) || 50, 1), 200);
    const ownerFilter = req.user!.role === "admin" ? "TRUE" : "g.owner_id=$2";
    const rows = await svc.db.query(
      `SELECT g.id, g.title, g.state, g.priority, g.owner_id, g.budget_cap_usd,
              g.created_at, g.updated_at, g.current_version, g.project_id, g.session_id,
              (SELECT count(*)::int FROM tasks t WHERE t.goal_id=g.id) AS task_count,
              (SELECT a.status FROM attempts a WHERE a.goal_id=g.id AND a.status='COMMITTED'
                 ORDER BY a.created_at DESC LIMIT 1) AS last_attempt_status
         FROM goals g
        WHERE (${ownerFilter})
          AND ($3::text IS NULL OR g.state=$3)
          AND ($4::text IS NULL OR g.title ILIKE $4)
        ORDER BY g.updated_at DESC
        LIMIT $1`,
      [limit, req.user!.id, state, search],
    );
    return { goals: rows.rows };
  });

  app.get("/v1/goals/:id", async (req, reply) => {
    if (!(await requireAuth(req, reply))) return;
    if (!(await goalScope(req, reply, (req.params as any).id))) return;
    const card = await svc.goals.workCard((req.params as any).id);
    if (!card) return reply.code(404).send({ error: "goal not found" });
    const att = (await svc.db.query(
      "SELECT * FROM attempts WHERE goal_id=$1 AND worker_id IS NOT NULL ORDER BY created_at DESC LIMIT 1", [(req.params as any).id],
    )).rows[0];
    return {
      ...card,
      last_heartbeat_at: att?.heartbeat_at ?? null,
      last_tool_progress_at: (await svc.db.query(
        `SELECT max(tr.created_at) AS t FROM tool_results tr JOIN attempts a ON a.id=tr.attempt_id WHERE a.goal_id=$1`, [(req.params as any).id],
      )).rows[0]?.t ?? null,
    };
  });

  app.get("/v1/goals/:id/report.md", async (req, reply) => {
    if (!(await requireAuth(req, reply))) return;
    const goalId = (req.params as any).id;
    if (!(await goalScope(req, reply, goalId))) return;
    // run report: every value below is read from the real ledger (P19 feature)
    const goal = (await svc.db.query("SELECT * FROM goals WHERE id=$1", [goalId])).rows[0] as
      { title: string; state: string; current_version: number; priority: number; created_at: string; updated_at: string; budget_cap_usd: string } | undefined;
    if (!goal) return reply.code(404).send({ error: "goal not found" });
    const tasks = (await svc.db.query(
      `SELECT node_key, role, title, state, failure_count, visit_count FROM tasks WHERE goal_id=$1 ORDER BY created_at`, [goalId])).rows;
    const att = (await svc.db.query(
      `SELECT status, count(*)::int AS n, COALESCE(sum(model_calls),0)::int AS calls,
              COALESCE(sum(settled_usd),0)::float AS usd
         FROM attempts WHERE goal_id=$1 GROUP BY status ORDER BY status`, [goalId])).rows;
    const budget = (await svc.db.query(
      `SELECT status, sum(settled_usd) AS settled, sum(unknown_usd) AS unknown, sum(reserved_usd) AS reserved
         FROM budget_reservations WHERE goal_id=$1 GROUP BY status`, [goalId])).rows;
    const events = (await svc.db.query(
      `SELECT event_type, payload, occurred_at FROM events
        WHERE goal_id=$1 AND event_type IN
          ('goal.created','goal.revised','attempt.committed','attempt.lost','goal.completed',
           'candidate.promoted','candidate.rolled_back','release.created','goal.priority_changed')
        ORDER BY seq ASC LIMIT 400`, [goalId])).rows;
    const artifacts = (await svc.db.query(
      `SELECT name, media_type, size_bytes, producer_role FROM artifacts WHERE goal_id=$1 ORDER BY created_at DESC LIMIT 50`, [goalId])).rows;
    const claims = (await svc.db.query(
      `SELECT text, stance, kind FROM claims WHERE goal_id=$1 ORDER BY created_at DESC LIMIT 20`, [goalId])).rows;

    const md: string[] = [];
    md.push(`# LoopLab 目标运行报告`);
    md.push("");
    md.push(`- 目标：${goal.title}`);
    md.push(`- 状态：**${goal.state}** · 版本 v${goal.current_version} · 优先级 ${goal.priority}`);
    md.push(`- 创建：${new Date(goal.created_at).toISOString()} · 更新：${new Date(goal.updated_at).toISOString()}`);
    md.push(`- 预算上限：$${Number(goal.budget_cap_usd).toFixed(2)}`);
    md.push("");
    md.push(`## 任务图（${tasks.length} 个节点）`);
    md.push("");
    md.push("| 节点 | 角色 | 状态 | 失败次数 |");
    md.push("|---|---|---|---|");
    for (const t of tasks) md.push(`| ${t.node_key} | ${t.role} | ${t.state} | ${t.failure_count} |`);
    md.push("");
    md.push(`## 执行与花费`);
    md.push("");
    md.push("| Attempt 状态 | 数量 | 模型调用 | 结算花费 |");
    md.push("|---|---|---|---|");
    for (const a of att) md.push(`| ${a.status} | ${a.n} | ${a.calls} | $${Number(a.usd).toFixed(4)} |`);
    for (const b of budget) {
      md.push("");
      md.push(`- 预算分账（${b.status}）：结算 $${Number(b.settled ?? 0).toFixed(4)} · 未结算 $${Number(b.unknown ?? 0).toFixed(4)} · 预留 $${Number(b.reserved ?? 0).toFixed(4)}`);
    }
    md.push("");
    md.push(`## 关键事件时间线`);
    md.push("");
    for (const e of events) {
      const brief = e.event_type === "attempt.committed"
        ? `${e.payload?.outcome ?? ""} ${String(e.payload?.summary ?? "").slice(0, 80)}`
        : e.event_type === "goal.revised"
          ? String(e.payload?.objective ?? "").slice(0, 80)
          : "";
      md.push(`- \`${new Date(e.occurred_at).toISOString()}\` ${e.event_type}${brief ? ` — ${brief}` : ""}`);
    }
    md.push("");
    md.push(`## 交付物（最近 ${artifacts.length} 项）`);
    md.push("");
    for (const a of artifacts) md.push(`- ${a.name}（${a.media_type}, ${a.size_bytes}B, by ${a.producer_role}）`);
    if (claims.length) {
      md.push("");
      md.push(`## 结论声明`);
      md.push("");
      for (const c of claims) md.push(`- [${c.stance}] ${c.text}`);
    }
    reply.header("content-type", "text/markdown; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="report-${goalId}.md"`);
    return md.join("\n");
  });

  app.post("/v1/goals/:id/commands", async (req, reply) => {
    if (!(await requireAuth(req, reply))) return;
    if (!(await goalScope(req, reply, (req.params as any).id))) return;
    const { kind, payload, command_id, expected_version } = req.body as any;
    if (!kind) return reply.code(400).send({ error: "kind required" });
    const receipt = await svc.goals.applyCommand({
      goalId: (req.params as any).id,
      commandId: String(command_id ?? `cmd_${randomBytes(8).toString("hex")}`),
      kind: String(kind),
      payload: payload ?? {},
      expectedRowVersion: expected_version != null ? Number(expected_version) : null,
      userId: req.user!.id,
    });
    return reply.code(receipt.status === "REJECTED" ? 409 : 202).send(receipt);
  });

  app.get("/v1/goals/:id/tasks", async (req, reply) => {
    if (!(await requireAuth(req, reply))) return;
    if (!(await goalScope(req, reply, (req.params as any).id))) return;
    const rows = await svc.db.query(
      `SELECT t.*, gv.version AS graph_version FROM tasks t
         JOIN graph_versions gv ON gv.id=t.graph_version_id
        WHERE t.goal_id=$1 ORDER BY t.created_at`, [(req.params as any).id],
    );
    return { tasks: rows.rows };
  });

  app.get("/v1/goals/:id/attempts", async (req, reply) => {
    if (!(await requireAuth(req, reply))) return;
    if (!(await goalScope(req, reply, (req.params as any).id))) return;
    const rows = await svc.db.query(
      `SELECT a.*, t.node_key, t.title AS task_title, t.role FROM attempts a
         JOIN tasks t ON t.id=a.task_id WHERE a.goal_id=$1 ORDER BY a.created_at DESC LIMIT 100`,
      [(req.params as any).id],
    );
    return { attempts: rows.rows };
  });

  app.get("/v1/attempts/:id/events", async (req, reply) => {
    if (!(await requireAuth(req, reply))) return;
    if (!(await attemptScope(req, reply, (req.params as any).id))) return;
    const rows = await svc.db.query(
      "SELECT * FROM events WHERE aggregate_id=$1 ORDER BY seq ASC LIMIT 500", [(req.params as any).id],
    );
    return { events: rows.rows };
  });

  // ---- evolution views ---------------------------------------------------------
  app.get("/v1/goals/:id/candidates", async (req, reply) => {
    if (!(await requireAuth(req, reply))) return;
    if (!(await goalScope(req, reply, (req.params as any).id))) return;
    const rows = await svc.db.query(
      `SELECT c.*, 
        (SELECT json_agg(json_build_object('status',h.status,'reason',h.reason,'at',h.at) ORDER BY h.at)
           FROM candidate_status_history h WHERE h.candidate_id=c.id) AS history
       FROM candidates c WHERE c.goal_id=$1 ORDER BY c.created_at DESC`,
      [(req.params as any).id],
    );
    return { candidates: rows.rows };
  });

  app.get("/v1/goals/:id/problems", async (req, reply) => {
    if (!(await requireAuth(req, reply))) return;
    if (!(await goalScope(req, reply, (req.params as any).id))) return;
    return { problems: (await svc.db.query("SELECT * FROM problems WHERE goal_id=$1 ORDER BY created_at DESC", [(req.params as any).id])).rows };
  });

  app.get("/v1/goals/:id/proposals", async (req, reply) => {
    if (!(await requireAuth(req, reply))) return;
    if (!(await goalScope(req, reply, (req.params as any).id))) return;
    return { proposals: (await svc.db.query("SELECT * FROM change_proposals WHERE goal_id=$1 ORDER BY created_at DESC", [(req.params as any).id])).rows };
  });

  app.get("/v1/goals/:id/releases", async (req, reply) => {
    if (!(await requireAuth(req, reply))) return;
    if (!(await goalScope(req, reply, (req.params as any).id))) return;
    return { releases: (await svc.db.query("SELECT * FROM releases WHERE goal_id=$1 ORDER BY created_at DESC", [(req.params as any).id])).rows };
  });

  app.get("/v1/pointers", async (req, reply) => {
    if (!(await requireAuth(req, reply))) return;
    return { pointers: (await svc.db.query("SELECT * FROM version_pointers")).rows };
  });

  // ---- evidence & research -------------------------------------------------------
  app.get("/v1/goals/:id/evidence", async (req, reply) => {
    if (!(await requireAuth(req, reply))) return;
    if (!(await goalScope(req, reply, (req.params as any).id))) return;
    const goalId = (req.params as any).id;
    const [artifacts, claims, hypotheses, skills, memories] = await Promise.all([
      svc.db.query("SELECT digest, name, media_type, size_bytes, producer_role, scope, created_at FROM artifacts WHERE goal_id=$1 ORDER BY created_at DESC LIMIT 200", [goalId]),
      svc.db.query("SELECT * FROM claims WHERE goal_id=$1 ORDER BY created_at DESC LIMIT 100", [goalId]),
      svc.db.query("SELECT * FROM hypotheses WHERE goal_id=$1 ORDER BY created_at DESC LIMIT 100", [goalId]),
      svc.db.query("SELECT * FROM skills WHERE scope <> 'global' OR status='candidate' ORDER BY created_at DESC LIMIT 100"),
      svc.db.query("SELECT id, kind, content, utility, status, created_at FROM memories WHERE goal_id=$1 ORDER BY created_at DESC LIMIT 100", [goalId]),
    ]);
    return {
      artifacts: artifacts.rows, claims: claims.rows,
      hypotheses: hypotheses.rows, skills: skills.rows, memories: memories.rows,
    };
  });

  app.get("/v1/artifacts/:digest", async (req, reply) => {
    if (!(await requireAuth(req, reply))) return;
    const row = (await svc.db.query("SELECT * FROM artifacts WHERE digest=$1", [(req.params as any).digest])).rows[0];
    if (!row) return reply.code(404).send({ error: "artifact not found" });
    // goal-scoped artifacts follow goal ownership; global-scope rows (shared
    // skill/library data) remain readable by any authenticated user
    if (row.goal_id && !(await goalScope(req, reply, row.goal_id))) return;
    const buf = await svc.objects.get(row.digest);
    if (!buf) return reply.code(404).send({ error: "object missing" });
    // Stored-XSS hardening (V19): artifact bytes are untrusted worker/model
    // output and the workbench opens downloads in a new tab. Scriptable media
    // types must never render on the API origin (same origin as the session
    // cookie), so they download as opaque bytes with sniffing disabled.
    const scriptable = /^(text\/html|application\/xhtml|image\/svg)/i.test(row.media_type ?? "");
    const safeName = String(row.name ?? "artifact")
      .replace(/[^\w. ()\-\u4e00-\u9fff]+/g, "_").replace(/\.{2,}/g, "_").replace(/^\.+/, "_")
      .slice(0, 120) || "artifact";
    reply.header("content-type", scriptable ? "application/octet-stream" : row.media_type);
    reply.header("content-disposition", `attachment; filename="${safeName}"`);
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-artifact-digest", row.digest);
    return buf;
  });

  // ---- research flow (hypothesis cards, frozen protocols, analysis) ---------
  app.post("/v1/goals/:id/hypotheses", async (req, reply) => {
    if (!(await requireAuth(req, reply))) return;
    if (!(await goalScope(req, reply, (req.params as any).id))) return;
    const b = req.body as any;
    const id = await svc.research.createHypothesis({
      goalId: (req.params as any).id, statement: String(b.statement ?? ""),
      mechanism: b.mechanism, applicability: b.applicability, keyVariable: b.key_variable,
      falsifier: b.falsifier, primaryMetric: b.primary_metric, minEffect: b.min_effect,
      nextStep: b.next_step, userId: req.user!.id,
    });
    return reply.code(201).send({ id });
  });

  app.get("/v1/goals/:id/hypotheses", async (req, reply) => {
    if (!(await requireAuth(req, reply))) return;
    if (!(await goalScope(req, reply, (req.params as any).id))) return;
    return { hypotheses: (await svc.db.query("SELECT * FROM hypotheses WHERE goal_id=$1 ORDER BY created_at DESC", [(req.params as any).id])).rows };
  });

  app.post("/v1/hypotheses/:id/protocol", async (req, reply) => {
    if (!(await requireAuth(req, reply))) return;
    const b = req.body as any;
    try {
      const planId = await svc.research.freezeProtocol({
        hypothesisId: (req.params as any).id,
        arms: b.arms, repetitions: Number(b.repetitions ?? 3),
        seeds: (b.seeds ?? []).map(Number),
        analysisPlan: {
          metric: String(b.analysis_plan?.metric ?? "cost_us"),
          minEffect: Number(b.analysis_plan?.min_effect ?? 0),
          alpha: Number(b.analysis_plan?.alpha ?? 0.05),
          minRepetitions: Number(b.analysis_plan?.min_repetitions ?? 5),
        },
        runnerRef: String(b.runner_ref ?? "taskpacks/computational-research/experiment.py"),
      });
      return reply.code(201).send({ plan_id: planId });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // research plans hang off hypotheses, which hang off goals — resolve the
  // owning goal so run/analyze respect the same isolation as every other
  // goal-scoped route (P22 fix: both were reachable by id alone)
  const planScope = async (req: any, reply: FastifyReply, planId: string): Promise<{ goal_id: string } | null> => {
    const row = (await svc.db.query(
      `SELECT g.id AS goal_id, g.owner_id FROM experiment_plans ep
         JOIN hypotheses h ON h.id = ep.hypothesis_id
         JOIN goals g ON g.id = h.goal_id
        WHERE ep.id=$1`, [planId],
    )).rows[0] as { goal_id: string; owner_id: string } | undefined;
    if (!row || (req.user!.role !== "admin" && row.owner_id !== req.user!.id)) {
      reply.code(404).send({ error: "plan not found" });
      return null;
    }
    return row;
  };
  /** Async runner child: spawnSync here used to freeze the WHOLE control
   *  process for up to 120s — heartbeats, SSE and the orchestrator all
   *  stalled, and lease expiry would then mark live attempts LOST (P22 fix). */
  const runRunner = (runnerScript: string, reqBody: unknown, timeoutMs: number) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn("python", [runnerScript], {
        env: infraEnv(),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "", stderr = "";
      const timer = setTimeout(() => child.kill(), timeoutMs);
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
      child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
      child.stdin.write(JSON.stringify(reqBody));
      child.stdin.end();
    });

  app.post("/v1/plans/:id/run", async (req, reply) => {
    if (!(await requireAuth(req, reply))) return;
    // execute the frozen protocol with the real deterministic runner
    const planId = (req.params as any).id;
    if (!(await planScope(req, reply, planId))) return;
    const plan = (await svc.db.query("SELECT * FROM experiment_plans WHERE id=$1", [planId])).rows[0];
    const runs = (await svc.db.query(
      "SELECT id, arm, seed, params FROM experiment_runs WHERE plan_id=$1 AND status='PENDING'", [planId],
    )).rows;
    if (!runs.length) return reply.code(409).send({ error: "no pending runs for this plan" });
    const reqBody = { runs: runs.map((r: any) => ({ arm: r.arm, seed: r.seed, params: r.params })) };
    const runnerScript = path.resolve(svc.config.dataDir, "taskpacks", "computational-research", "experiment.py");
    let proc: { code: number | null; stdout: string; stderr: string };
    try {
      proc = await runRunner(runnerScript, reqBody, 120_000);
    } catch (err) {
      return reply.code(500).send({ error: `runner failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300) });
    }
    if (proc.code !== 0) return reply.code(500).send({ error: (proc.stderr || "runner failed").slice(0, 300) });
    let out: any;
    try { out = JSON.parse(proc.stdout); } catch { return reply.code(500).send({ error: "runner output unreadable" }); }
    for (const r of out.runs as any[]) {
      const match = runs.find((x: any) => x.arm === r.arm && Number(x.seed) === Number(r.seed));
      if (!match) continue;
      await svc.db.query(
        `UPDATE experiment_runs SET metrics=$2, runtime_ms=$3, status=$4 WHERE id=$1`,
        // runtime_ms arrives as fractional ms from the runner; the column is
        // integer — an unrounded value used to blow up the whole UPDATE (P22)
        [match.id, JSON.stringify(r.metrics ?? {}), Math.round(Number(r.runtime_ms ?? 0)), r.status === "DONE" ? "DONE" : "FAILED"],
      );
    }
    const done = Number((await svc.db.query("SELECT count(*)::int AS n FROM experiment_runs WHERE plan_id=$1 AND status='DONE'", [planId])).rows[0]?.n ?? 0);
    return { plan_id: planId, executed: out.runs.length, done_total: done };
  });

  app.post("/v1/plans/:id/analyze", async (req, reply) => {
    if (!(await requireAuth(req, reply))) return;
    const planId = (req.params as any).id;
    if (!(await planScope(req, reply, planId))) return;
    const analysis = await svc.research.analyze(planId);
    await svc.research.recordOutcome(planId, analysis.verdict, analysis.detail, analysis.stats);
    return analysis;
  });

  app.post("/v1/goals/:id/evidence/verify", async (req, reply) => {
    if (!(await requireAuth(req, reply))) return;
    return svc.evidence.verifyReferences((req.params as any).id);
  });

  app.post("/v1/goals/:id/claims", async (req, reply) => {
    if (!(await requireAuth(req, reply))) return;
    if (!(await goalScope(req, reply, (req.params as any).id))) return;
    const b = req.body as any;
    const id = `clm_${randomBytes(6).toString("hex")}`;
    await svc.db.query(
      `INSERT INTO claims (id, goal_id, text, stance, scope, kind, evidence_refs)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, (req.params as any).id, String(b.text ?? ""), String(b.stance ?? "证据不足"),
        String(b.scope ?? ""), String(b.kind ?? "inference"), JSON.stringify(b.evidence_refs ?? [])],
    );
    return reply.code(201).send({ id });
  });

  // ---- evolution operations (HTTP surface for the evolution loop) ----------
  app.post("/v1/goals/:id/evolution/collect-problems", async (req, reply) => {
    if (!(await requireAuth(req, reply))) return;
    if (!(await goalScope(req, reply, (req.params as any).id))) return;
    const ids = await svc.evolution.collectProblems((req.params as any).id);
    return { problem_ids: ids };
  });

  app.post("/v1/goals/:id/evolution/propose", async (req, reply) => {
    if (!(await requireAuth(req, reply))) return;
    if (!(await goalScope(req, reply, (req.params as any).id))) return;
    const { problem_id, taskpack_id, allowed_path, baseline_path } = req.body as any;
    const prop = await svc.evolution.proposeChange({
      goalId: (req.params as any).id, problemId: String(problem_id),
      taskpackId: String(taskpack_id ?? "algorithm-search.bin-packing"),
      allowedPath: String(allowed_path ?? "heuristic.py"),
      baselinePath: baseline_path ? String(baseline_path) : undefined,
    });
    if (!prop) return reply.code(502).send({ error: "proposer produced no usable proposal" });
    return reply.code(202).send(prop);
  });

  app.post("/v1/goals/:id/evolution/build", async (req, reply) => {
    if (!(await requireAuth(req, reply))) return;
    if (!(await goalScope(req, reply, (req.params as any).id))) return;
    const { proposal_id, taskpack_id, allowed_path } = req.body as any;
    const candId = await svc.evolution.buildCandidate({
      goalId: (req.params as any).id, proposalId: String(proposal_id),
      taskpackId: String(taskpack_id ?? "algorithm-search.bin-packing"),
      allowedPath: String(allowed_path ?? "heuristic.py"),
    });
    if (!candId) return reply.code(502).send({ error: "no candidate code available for this proposal" });
    return reply.code(202).send({ candidate_id: candId });
  });

  app.post("/v1/goals/:id/evolution/evaluate", async (req, reply) => {
    if (!(await requireAuth(req, reply))) return;
    if (!(await goalScope(req, reply, (req.params as any).id))) return;
    const { candidate_id, taskpack_id, contract_version } = req.body as any;
    const res = await svc.evolution.evaluateCandidate({
      goalId: (req.params as any).id, candidateId: String(candidate_id),
      taskpackId: String(taskpack_id ?? "algorithm-search.bin-packing"),
      contractVersion: String(contract_version ?? "bin-packing/v1"),
    });
    return res;
  });

  app.post("/v1/goals/:id/evolution/promote", async (req, reply) => {
    if (!(await requireAuth(req, reply))) return;
    if (!(await goalScope(req, reply, (req.params as any).id))) return;
    const { candidate_id, scope, kind } = req.body as any;
    const res = await svc.evolution.promote({
      goalId: (req.params as any).id, candidateId: String(candidate_id),
      scope: String(scope ?? "algorithm:bin-packing"),
      kind: kind === "full" ? "full" : "canary",
    });
    return reply.code(res.ok ? 200 : 409).send(res);
  });

  app.post("/v1/goals/:id/releases/:releaseId/rollback", async (req, reply) => {
    // operator-initiated rollback of a canary/full release pointer
    if (!(await requireAuth(req, reply))) return;
    if (!(await goalScope(req, reply, (req.params as any).id))) return;
    const { scope, reason } = req.body as any;
    try {
      const res = await svc.releases.rollback({
        scope: String(scope ?? "algorithm:bin-packing"),
        releaseId: (req.params as any).releaseId,
        reason: String(reason ?? "operator rollback"),
        actor: `user:${req.user!.id}`,
      });
      return res;
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/v1/goals/:id/evolution/canary-check", async (req, reply) => {
    if (!(await requireAuth(req, reply))) return;
    if (!(await goalScope(req, reply, (req.params as any).id))) return;
    const { scope, taskpack_id } = req.body as any;
    const res = await svc.evolution.checkCanaryRegression(
      String(scope ?? "algorithm:bin-packing"),
      String(taskpack_id ?? "algorithm-search.bin-packing"),
    );
    return res;
  });

  // ---- optimizer port (design §5.3, §6.8) ----------------------------------
  // Session-authenticated management surface. The backend process itself
  // authenticates with the run token issued by createRun; it never sees the
  // model key and can only reach the metered LLM proxy + complete.
  app.post("/v1/goals/:id/optimizer/runs", async (req, reply) => {
    if (!(await requireAuth(req, reply))) return;
    if (!(await goalScope(req, reply, (req.params as any).id))) return;
    const b = req.body as any;
    try {
      const res = await svc.optimizer.createRun({
        goalId: (req.params as any).id,
        backend: String(b.backend ?? "gepa@0.1.4"),
        mode: b.mode === "epoch_trial" ? "epoch_trial" : "active",
        maxMetricCalls: Number(b.max_metric_calls ?? 60),
        maxLlmCostUsd: Number(b.max_llm_cost_usd ?? 0.5),
        reflection: b.reflection === "scripted" ? "scripted" : "gateway",
        gatewayUrl: `${req.protocol}://${req.headers.host}/v1/optimizer/llm`,
        taskpackId: b.taskpack_id ? String(b.taskpack_id) : undefined,
      });
      return reply.code(201).send(res);
    } catch (err) {
      if (err instanceof BudgetExceededError) return reply.code(402).send({ error: err.message });
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/v1/goals/:id/optimizer/runs", async (req, reply) => {
    if (!(await requireAuth(req, reply))) return;
    if (!(await goalScope(req, reply, (req.params as any).id))) return;
    const runs = await svc.optimizer.listRuns((req.params as any).id);
    // tokens are hash-stored; nothing secret is ever returned
    return { runs: runs.map(({ manifest, ...rest }) => ({ ...rest, reflection: manifest?.reflection })) };
  });

  app.post("/v1/goals/:id/optimizer/run-round", async (req, reply) => {
    if (!(await requireAuth(req, reply))) return;
    if (!(await goalScope(req, reply, (req.params as any).id))) return;
    const b = req.body as any;
    try {
      const res = await svc.optimizer.runBackendRound({
        goalId: (req.params as any).id,
        backend: String(b.backend ?? "gepa@0.1.4"),
        mode: b.mode === "epoch_trial" ? "epoch_trial" : "active",
        maxMetricCalls: Number(b.max_metric_calls ?? 60),
        maxLlmCostUsd: Number(b.max_llm_cost_usd ?? 0.5),
        reflection: b.reflection === "scripted" ? "scripted" : "gateway",
        baseUrl: `${req.protocol}://${req.headers.host}`,
        timeoutMs: b.timeout_ms ? Number(b.timeout_ms) : undefined,
        taskpackId: b.taskpack_id ? String(b.taskpack_id) : undefined,
      });
      return reply.code(202).send(res);
    } catch (err) {
      if (err instanceof BudgetExceededError) return reply.code(402).send({ error: err.message });
      return reply.code(502).send({ error: err instanceof Error ? err.message.slice(0, 400) : String(err) });
    }
  });

  app.post("/v1/optimizer/llm", async (req, reply) => {
    // token-authenticated metered proxy for optimizer reflection calls
    const authz = String(req.headers.authorization ?? "");
    const token = authz.startsWith("Bearer ") ? authz.slice(7) : "";
    if (!token) return reply.code(401).send({ error: "optimizer run token required" });
    const b = req.body as any;
    try {
      const res = await svc.optimizer.meteredLlm({
        token,
        callSeq: Number(b.call_seq ?? 0),
        messages: Array.isArray(b.messages) ? b.messages : [],
        maxTokens: b.max_tokens ? Number(b.max_tokens) : undefined,
        temperature: b.temperature ?? undefined,
      });
      return res;
    } catch (err) {
      if (err instanceof BudgetExceededError) return reply.code(402).send({ error: err.message });
      if (err instanceof OptimizerAuthError) return reply.code(401).send({ error: err.message });
      return reply.code(502).send({ error: err instanceof Error ? err.message.slice(0, 300) : String(err) });
    }
  });

  app.post("/v1/optimizer/runs/:id/complete", async (req, reply) => {
    const authz = String(req.headers.authorization ?? "");
    const token = authz.startsWith("Bearer ") ? authz.slice(7) : "";
    if (!token) return reply.code(401).send({ error: "optimizer run token required" });
    const b = req.body as any;
    try {
      const res = await svc.optimizer.completeRun({
        token,
        payload: { proposals: b.proposals ?? [], usage: b.usage, stopped_reason: b.stopped_reason },
      });
      return res;
    } catch (err) {
      if (err instanceof OptimizerAuthError) return reply.code(401).send({ error: err.message });
      return reply.code(400).send({ error: err instanceof Error ? err.message.slice(0, 300) : String(err) });
    }
  });

  app.get("/v1/meta/epoch", async (req, reply) => {
    if (!(await requireAuth(req, reply))) return;
    return { epoch: await svc.optimizer.currentEpoch() };
  });

  app.post("/v1/meta/epoch/settle", async (req, reply) => {
    if (!(await requireAuth(req, reply))) return;
    const b = req.body as any;
    try {
      return await svc.optimizer.settleEpochTrial({
        incumbent: String(b.incumbent), challenger: String(b.challenger),
        incumbentImprovement: Number(b.incumbent_improvement ?? 0),
        challengerImprovement: Number(b.challenger_improvement ?? 0),
        minMargin: Number(b.min_margin ?? 0.05),
      });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ---- approvals -------------------------------------------------------------------
  app.get("/v1/approvals", async (req, reply) => {
    if (!(await requireAuth(req, reply))) return;
    return { approvals: (await svc.db.query("SELECT * FROM approvals WHERE status='PENDING' ORDER BY created_at")).rows };
  });

  app.post("/v1/approvals/:id/decision", async (req, reply) => {
    if (!(await requireAuth(req, reply))) return;
    const { decision } = req.body as any;
    if (!["approve", "reject"].includes(decision)) return reply.code(400).send({ error: "decision must be approve|reject" });
    const row = (await svc.db.query("SELECT * FROM approvals WHERE id=$1 FOR UPDATE", [(req.params as any).id])).rows[0];
    if (!row) return reply.code(404).send({ error: "approval not found" });
    if (row.status !== "PENDING") return reply.code(409).send({ error: `already ${row.status}` });
    await svc.db.query(
      "UPDATE approvals SET status=$2, decided_by=$3, decided_at=now() WHERE id=$1",
      [(req.params as any).id, decision === "approve" ? "APPROVED" : "REJECTED", req.user!.username],
    );
    await svc.db.tx(async (client) => {
      await EventStore.append(client, {
        aggregateType: "approval", aggregateId: (req.params as any).id,
        eventType: decision === "approve" ? "approval.granted" : "approval.rejected",
        goalId: row.goal_id, actor: { kind: "user", id: req.user!.id },
        payload: { kind: row.kind },
      });
      // approving a goal_revise approval enqueues an ACCEPTED revise command;
      // the orchestrator applies it through the existing revision pipeline
      if (decision === "approve" && row.kind === "goal_revise") {
        const detail = typeof row.detail === "string" ? JSON.parse(row.detail) : row.detail ?? {};
        await client.query(
          `INSERT INTO commands (id, command_id, goal_id, kind, payload, status, actor)
           VALUES ($1,$2,$3,'revise',$4,'ACCEPTED',$5)`,
          [`cmd_${randomBytes(8).toString("hex")}`, `cmd_${randomBytes(8).toString("hex")}`,
            row.goal_id, JSON.stringify({ content: String(detail.content ?? "") }),
            JSON.stringify({ kind: "user", id: req.user!.id })],
        );
        await EventStore.append(client, {
          aggregateType: "goal", aggregateId: row.goal_id, eventType: "goal.revise_commanded",
          goalId: row.goal_id, actor: { kind: "user", id: req.user!.id },
          payload: { via_approval: (req.params as any).id },
        });
      }
    });
    return { ok: true };
  });

  // ---- worker API (worker identity = registration token, P17) --------------------
  app.post("/v1/worker/claim", { preHandler: requireWorkerToken }, async (req, reply) => {
    const { worker_id, runtime, version } = req.body as any;
    if (!worker_id) return reply.code(400).send({ error: "worker_id required" });
    const job = await svc.scheduler.claim(String(worker_id), {
      runtime: runtime ? String(runtime).slice(0, 40) : undefined,
      version: version ? String(version).slice(0, 40) : undefined,
    });
    if (!job) return reply.code(204).send();
    return job;
  });

  app.post("/v1/attempts/:id/heartbeat", { preHandler: requireWorkerToken }, async (req, reply) => {
    const { worker_id, lease_epoch } = req.body as any;
    const res = await svc.scheduler.heartbeat((req.params as any).id, String(worker_id), Number(lease_epoch));
    return res;
  });

  app.post("/v1/attempts/:id/start", { preHandler: requireWorkerToken }, async (req, reply) => {
    const { worker_id, lease_epoch } = req.body as any;
    try {
      await svc.attempts.reportStarted((req.params as any).id, String(worker_id), Number(lease_epoch));
      return { ok: true };
    } catch (err) {
      return fencingError(err, reply);
    }
  });

  app.post("/v1/attempts/:id/tools/authorize", { preHandler: requireWorkerToken }, async (req, reply) => {
    const { worker_id, lease_epoch, tool, args } = req.body as any;
    try {
      const decision = await svc.attempts.authorizeTool({
        attemptId: (req.params as any).id, workerId: String(worker_id), leaseEpoch: Number(lease_epoch),
        tool: String(tool), args: args ?? {},
      });
      return decision;
    } catch (err) {
      return fencingError(err, reply);
    }
  });

  app.post("/v1/attempts/:id/tools/report", { preHandler: requireWorkerToken }, async (req, reply) => {
    const { worker_id, lease_epoch, tool, ok, output_digest, output_bytes, duration_ms } = req.body as any;
    try {
      await svc.attempts.reportToolResult({
        attemptId: (req.params as any).id, workerId: String(worker_id), leaseEpoch: Number(lease_epoch),
        tool: String(tool), ok: Boolean(ok), outputDigest: output_digest ?? null,
        outputBytes: Number(output_bytes ?? 0), durationMs: Number(duration_ms ?? 0),
      });
      return { ok: true };
    } catch (err) {
      return fencingError(err, reply);
    }
  });

  app.post("/v1/attempts/:id/steers/:steerId/delivered", { preHandler: requireWorkerToken }, async (req, reply) => {
    const { worker_id, lease_epoch } = req.body as any;
    const res = await svc.scheduler.confirmSteerDelivered((req.params as any).id, (req.params as any).steerId, String(worker_id), Number(lease_epoch));
    return reply.code(res.ok ? 200 : 409).send(res);
  });

  app.post("/v1/attempts/:id/checkpoint", { preHandler: requireWorkerToken }, async (req, reply) => {
    const { worker_id, lease_epoch, step_index, summary, state, artifact_refs, progress_kind } = req.body as any;
    try {
      const res = await svc.attempts.checkpoint({
        attemptId: (req.params as any).id, workerId: String(worker_id), leaseEpoch: Number(lease_epoch),
        stepIndex: Number(step_index ?? 0), summary: String(summary ?? ""), state: state ?? {},
        artifactRefs: artifact_refs ?? [], progressKind: String(progress_kind ?? "tool_progress"),
      });
      return res;
    } catch (err) {
      return fencingError(err, reply);
    }
  });

  app.get("/v1/attempts/:id/propagated/:digest", { preHandler: requireWorkerToken }, async (req, reply) => {
    // worker-fenced materialization download: the digest must be in THIS
    // attempt's propagated list (claim-time resolved), so a worker can only
    // fetch the predecessor inputs it was granted
    const { id, digest } = req.params as any;
    const worker_id = String((req.query as any).worker_id ?? "");
    const lease_epoch = Number((req.query as any).lease_epoch ?? 0);
    const att = (await svc.db.query("SELECT * FROM attempts WHERE id=$1", [id])).rows[0];
    if (!att) return reply.code(404).send({ error: "unknown attempt" });
    if (att.worker_id !== worker_id || Number(att.lease_epoch) !== lease_epoch) {
      return reply.code(409).send({ error: "fencing", reason: "stale fencing token" });
    }
    const spec = (await svc.db.query("SELECT spec FROM attempt_specs WHERE attempt_id=$1", [id])).rows[0]?.spec;
    const granted = (spec?.propagated_artifacts ?? []).some((p: any) => p.digest === digest);
    if (!granted) return reply.code(403).send({ error: "digest not granted for this attempt" });
    const row = (await svc.db.query("SELECT * FROM artifacts WHERE digest=$1 AND scope='task'", [digest])).rows[0];
    if (!row) return reply.code(404).send({ error: "artifact not found" });
    const buf = await svc.objects.get(row.digest);
    if (!buf) return reply.code(404).send({ error: "object missing" });
    reply.header("content-type", row.media_type);
    reply.header("x-artifact-name", encodeURIComponent(row.name));
    return buf;
  });

  app.post("/v1/artifacts", { preHandler: requireWorkerToken }, async (req, reply) => {
    const body = req.body as Buffer;
    const headers = req.headers as any;
    if (!body?.length) return reply.code(400).send({ error: "empty body" });
    // workers send x-artifact-name percent-encoded; decode ONCE at ingest —
    // storing the encoded form used to double-encode names on download (P19)
    let name = String(headers["x-artifact-name"] ?? "unnamed");
    try { name = decodeURIComponent(name); } catch { /* keep raw */ }
    const res = await svc.attempts.putArtifact({
      body, name,
      mediaType: String(headers["x-artifact-media-type"] ?? "application/octet-stream"),
      producerRun: String(headers["x-attempt-id"] ?? "external"),
      producerRole: String(headers["x-producer-role"] ?? "worker"),
      goalId: (headers["x-goal-id"] as string) || null,
      scope: String(headers["x-scope"] ?? "task"),
    });
    return res;
  });

  app.post("/v1/attempts/:id/commit", { preHandler: requireWorkerToken }, async (req, reply) => {
    const { worker_id } = req.body as any;
    try {
      const res = await svc.attempts.commit({ workerId: String(worker_id), payload: req.body });
      return res;
    } catch (err) {
      if (err instanceof FencingError) {
        // late worker: quarantine the payload, never advance state (A04/A05)
        await svc.attempts.quarantineCommit(req.body, err.reason);
        return reply.code(409).send({ error: "fencing", reason: err.reason, quarantined: true });
      }
      throw err;
    }
  });

  // ---- LLM proxy for workers (budget-gated; key stays server-side) --------------
  app.post("/v1/attempts/:id/llm", { preHandler: requireWorkerToken }, async (req, reply) => {
    const { worker_id, lease_epoch, messages, tools, max_tokens, temperature, idempotency_key } = req.body as any;
    try {
      // fencing first (cheap read; the gateway reserves budget itself)
      const att = (await svc.db.query("SELECT * FROM attempts WHERE id=$1", [(req.params as any).id])).rows[0];
      if (!att) return reply.code(404).send({ error: "unknown attempt" });
      if (att.worker_id !== String(worker_id) || Number(att.lease_epoch) !== Number(lease_epoch)) {
        return reply.code(409).send({ error: "fencing", reason: "stale fencing token" });
      }
      if (att.model_calls >= 64) return reply.code(429).send({ error: "model call cap reached for this attempt" });
      const result = await svc.llm.call({
        goalId: att.goal_id, attemptId: att.id, scope: "task_execution",
        messages, tools, maxTokens: Number(max_tokens ?? 2048), temperature: temperature ? Number(temperature) : undefined,
        idempotencyKey: String(idempotency_key ?? `att_${att.id}_${att.model_calls}_${Date.now()}`),
        actor: { kind: "worker", id: String(worker_id) },
      });
      return result;
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        return reply.code(402).send({ error: "budget_exceeded", detail: err.detail });
      }
      throw err;
    }
  });

  // ---- SSE event stream (cursor replay, A03/A23) ------------------------------------
  app.get("/v1/events", async (req, reply) => {
    if (!(await requireAuth(req, reply))) return;
    const q = req.query as any;
    // cursor precedence: explicit ?after, then the standard Last-Event-ID
    // header (native EventSource resume — the restart path must not lose
    // events committed while the previous process was dying), else live tail.
    const maxSeq = async () =>
      BigInt(String((await svc.db.query("SELECT COALESCE(MAX(seq),0) AS s FROM events")).rows[0]?.s ?? "0"));
    let after: bigint;
    if (q.after) {
      try { after = BigInt(String(q.after)); } catch { after = await maxSeq(); }
    } else if (req.headers["last-event-id"]) {
      try { after = BigInt(String(req.headers["last-event-id"])); } catch { after = await maxSeq(); }
    } else {
      after = await maxSeq();
    }
    const goalId = q.goal_id ?? null;
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    reply.raw.write(`retry: 2000\n\n`);
    let cursor = after;
    let closed = false;
    // release the poll timer on disconnect — a leaked 1s interval per dead
    // connection used to accumulate across reconnects (P17 fix)
    let timer: NodeJS.Timeout | null = null;
    req.raw.on("close", () => {
      closed = true;
      if (timer) { clearInterval(timer); timer = null; }
    });
    const poll = async () => {
      try {
        const events = await EventStore.after(svc.db, cursor,
          { goalId: goalId ?? undefined, owner: { id: req.user!.id, isAdmin: req.user!.role === "admin" } }, 200);
        for (const e of events) {
          reply.raw.write(`id: ${e.seq}\nevent: platform\ndata: ${JSON.stringify({
            schema_version: "1", event_id: e.event_id, aggregate_type: e.aggregate_type,
            aggregate_id: e.aggregate_id, sequence: e.aggregate_seq, event_type: e.event_type,
            goal_id: e.goal_id, goal_version: e.goal_version, trace_id: e.trace_id,
            causation_id: e.causation_id, actor: e.actor, lease_epoch: e.lease_epoch,
            payload: e.payload, occurred_at: e.occurred_at, ingested_at: e.ingested_at,
          })}\n\n`);
          cursor = BigInt(e.seq);
        }
        if (events.length === 0) {
          reply.raw.write(`: ping ${Date.now()}\n\n`);
        }
      } catch (err) {
        if (!closed) reply.raw.write(`event: stream_error\ndata: ${JSON.stringify({ message: String(err) })}\n\n`);
      }
    };
    timer = setInterval(() => { if (!closed) poll(); }, 1000);
    timer.unref();
    // initial catch-up
    await poll();
  });

  // ---- settings (never returns secrets) ----------------------------------------------
  app.get("/v1/settings/model", async (req, reply) => {
    if (!(await requireAuth(req, reply))) return;
    // fingerprint the key instead of exposing its real prefix/suffix
    const fp = createHash("sha256").update(svc.config.deepseek.apiKey).digest("hex").slice(0, 12);
    return {
      provider: "deepseek",
      chat_model: svc.config.deepseek.chatModel,
      reasoner_model: svc.config.deepseek.reasonerModel,
      base_url_configured: true,
      key_configured: true, // never the key itself
      key_fingerprint: `sha256:${fp}`,
    };
  });

  // ---- workers registry (P18: live fleet visibility) ----------------------------------
  app.get("/v1/workers", async (req, reply) => {
    if (!(await requireAuth(req, reply))) return;
    const rows = (await svc.db.query(
      `SELECT w.*, a.status AS last_attempt_status, t.title AS last_task_title
         FROM workers w
         LEFT JOIN attempts a ON a.id = w.last_attempt_id
         LEFT JOIN tasks t ON t.id = a.task_id
        ORDER BY w.last_seen_at DESC`,
    )).rows;
    const aliveWindowMs = svc.config.leaseTtlMs * 2;
    const now = Date.now();
    return {
      workers: rows.map((w: any) => ({
        ...w,
        alive: Boolean(w.last_seen_at) && now - new Date(w.last_seen_at).getTime() < aliveWindowMs,
        claims_total: Number(w.claims_total ?? 0),
        polls_total: Number(w.polls_total ?? 0),
      })),
    };
  });

  app.get("/v1/metrics", async (req, reply) => {
    // was unauthenticated: spend, goal counts and orchestrator internals are
    // business data — now session-gated like every other read (P17)
    if (!(await requireAuth(req, reply))) return;
    const q = async (sql: string) => (await svc.db.query(sql)).rows[0];
    const [goals, attempts, events, budget, modelCalls, today] = await Promise.all([
      svc.db.query("SELECT state, count(*)::int AS n FROM goals GROUP BY state"),
      svc.db.query("SELECT status, count(*)::int AS n FROM attempts GROUP BY status"),
      q("SELECT count(*)::int AS n, COALESCE(MAX(seq),0)::bigint AS head FROM events"),
      svc.db.query("SELECT status, sum(settled_usd) AS settled, sum(unknown_usd) AS unknown, sum(reserved_usd) AS reserved FROM budget_reservations GROUP BY status"),
      q("SELECT COALESCE(sum(model_calls),0)::int AS calls, COALESCE(sum(settled_usd),0)::float AS usd FROM attempts"),
      q(`SELECT COALESCE(sum(settled_usd + reserved_usd + unknown_usd),0)::float AS usd
           FROM budget_reservations WHERE updated_at > now() - interval '24 hours'`),
    ]);
    return {
      uptime_s: Math.floor(process.uptime()),
      goals: goals.rows, attempts: attempts.rows,
      events: { count: Number(events?.n ?? 0), head: String(events?.head ?? 0) },
      budget: budget.rows,
      model: {
        calls: Number(modelCalls?.calls ?? 0), cost_usd: Number(modelCalls?.usd ?? 0),
        last_24h_usd: Number(today?.usd ?? 0), daily_cap_usd: svc.config.dailyBudgetUsd || null,
      },
      orchestrator: {
        last_reconcile_at: svc.orchestrator.lastReconcileAt?.toISOString() ?? null,
        reconcile_totals: svc.orchestrator.reconcileCounts,
        last_error: svc.orchestrator.lastError,
      },
    };
  });

  function fencingError(err: unknown, reply: FastifyReply) {
    if (err instanceof FencingError) return reply.code(409).send({ error: "fencing", reason: err.reason });
    throw err;
  }
}
