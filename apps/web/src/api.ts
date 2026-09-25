// API client: every value rendered in the UI comes from these real endpoints.
export class Api {
  private base = "";
  constructor(base = "") {
    this.base = base;
  }

  private async req<T>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}${url}`, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
    });
    if (res.status === 204) return null as T;
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    if (!res.ok) {
      const err = new Error(json?.error ?? json?.message ?? `HTTP ${res.status}`) as any;
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json as T;
  }

  get<T = any>(url: string) { return this.req<T>("GET", url); }
  post<T = any>(url: string, body?: unknown) { return this.req<T>("POST", url, body); }

  // ---- auth ----
  register(username: string, password: string) { return this.post("/v1/auth/register", { username, password }); }
  login(username: string, password: string) { return this.post("/v1/auth/login", { username, password }); }
  logout() { return this.post("/v1/auth/logout"); }
  me() { return this.get("/v1/me"); }

  // ---- projects/sessions ----
  projects() { return this.get("/v1/projects") as Promise<{ projects: Project[] }>; }
  sessions(projectId?: string | null) {
    const q = projectId ? `?project_id=${encodeURIComponent(projectId)}` : "";
    return this.get(`/v1/sessions${q}`) as Promise<{ sessions: Session[] }>;
  }
  createSession(projectId: string, title: string) { return this.post("/v1/sessions", { project_id: projectId, title }); }
  messages(sessionId: string) { return this.get(`/v1/sessions/${sessionId}/messages`) as Promise<{ messages: Message[] }>; }
  sendMessage(sessionId: string, content: string) { return this.post(`/v1/sessions/${sessionId}/messages`, { content }); }

  // ---- goals ----
  goal(goalId: string) { return this.get(`/v1/goals/${goalId}`) as Promise<WorkCard>; }
  tasks(goalId: string) { return this.get(`/v1/goals/${goalId}/tasks`) as Promise<{ tasks: Task[] }>; }
  attempts(goalId: string) { return this.get(`/v1/goals/${goalId}/attempts`) as Promise<{ attempts: Attempt[] }>; }
  attemptEvents(attemptId: string) { return this.get(`/v1/attempts/${attemptId}/events`) as Promise<{ events: PlatformEvent[] }>; }
  command(goalId: string, kind: string, payload: Record<string, unknown> = {}) {
    return this.post(`/v1/goals/${goalId}/commands`, { kind, payload, command_id: `cmd_${crypto.randomUUID().slice(0, 13)}` });
  }

  // ---- evolution / evidence ----
  candidates(goalId: string) { return this.get(`/v1/goals/${goalId}/candidates`) as Promise<{ candidates: Candidate[] }>; }
  evidence(goalId: string) { return this.get(`/v1/goals/${goalId}/evidence`) as Promise<EvidenceBundle>; }
  releases(goalId: string) { return this.get(`/v1/goals/${goalId}/releases`) as Promise<{ releases: ReleaseRow[] }>; }
  pointers() { return this.get("/v1/pointers") as Promise<{ pointers: Pointer[] }>; }
  artifactUrl(digest: string) { return `${this.base}/v1/artifacts/${digest}`; }
  reportUrl(goalId: string) { return `${this.base}/v1/goals/${goalId}/report.md`; }
  settingsModel() { return this.get("/v1/settings/model"); }
  metrics() { return this.get("/v1/metrics"); }
  workers() { return this.get("/v1/workers") as Promise<{ workers: WorkerRow[] }>; }

  // ---- optimizer / meta-evolution (RSI) ----
  optimizerRuns(goalId: string) { return this.get(`/v1/goals/${goalId}/optimizer/runs`) as Promise<{ runs: OptimizerRun[] }>; }
  metaEpoch() { return this.get("/v1/meta/epoch") as Promise<{ epoch: EpochInfo | null }>; }
  runOptimizerRound(goalId: string, body: Record<string, unknown> = {}) { return this.post(`/v1/goals/${goalId}/optimizer/run-round`, body); }
}

export interface Project { id: string; slug: string; name: string; }
export interface Session { id: string; project_id: string; title: string; state: string; goal_id: string | null; updated_at: string; }
export interface Message { id: string; session_id: string; role: string; content: string; data: unknown; created_at: string; }
export interface WorkCard {
  goal_id: string; title: string; state: string; version: number; objective: string;
  doing: string | null; last_progress: string | null; waiting_reason: string | null;
  next_step: string | null;
  budget: { used: number; cap: number; outstanding: number; unknown: number };
  verified: { done: number; total: number; source: string } | null;
  graph_version: string | null;
  last_heartbeat_at: string | null;
  last_tool_progress_at: string | null;
}
export interface Task { id: string; node_key: string; role: string; kind: string; title: string; state: string; failure_count: number; visit_count: number; depends_on?: string[]; graph_version?: string; }
export interface Attempt { id: string; task_id: string; attempt_no: number; worker_id: string | null; status: string; error_class: string | null; model_calls: number; settled_usd: string; started_at: string | null; ended_at: string | null; task_title: string; role: string; }
export interface PlatformEvent {
  seq: number; event_id: string; aggregate_type: string; aggregate_id: string;
  aggregate_seq: number; event_type: string; goal_id: string | null;
  actor: { kind: string; id: string } | null; lease_epoch: number | null;
  causation_id?: string | null;
  payload: any; occurred_at: string;
}
export interface Candidate {
  id: string; digest: string; kind: string; title: string; status: string;
  parents: string[]; history: { status: string; reason: string; at: string }[] | null;
}
export interface ReleaseRow { id: string; candidate_id: string; kind: string; status: string; parent_release: string | null; created_at: string; }
export interface Pointer { scope: string; candidate_id: string; release_id: string; pointer_version: number; }
export interface OptimizerRun {
  id: string; backend: string; mode: string; epoch_index: number | null; status: string;
  budget_max_metric_calls: number | null; budget_max_llm_cost_usd: number | null;
  spent_usd: string | number; llm_calls: number; metric_calls: number;
  stopped_reason: string | null; created_at: string; ended_at: string | null;
  reflection: string | null;
}
export interface EpochInfo { index: number; active_backend: string; frozen: boolean; status: string; }
export interface WorkerRow {
  id: string; first_seen_at: string; last_seen_at: string;
  claims_total: number; polls_total: number; heartbeats_total: number;
  last_attempt_id: string | null; last_attempt_status: string | null;
  last_task_title: string | null; runtime: string | null; alive: boolean;
}
export interface EvidenceBundle {
  artifacts: { digest: string; name: string; media_type: string; size_bytes: number; producer_role: string }[];
  claims: { id: string; text: string; stance: string; scope: string; kind: string }[];
  hypotheses: { id: string; statement: string; stage: string; state: string; verdict: string | null }[];
  skills: { id: string; name: string; version: string; status: string }[];
  memories: { id: string; kind: string; content: string; utility: string }[];
}

export const api = new Api();
