-- LoopLab schema 001: core ledger. All state changes happen in transactions
-- together with their events (design §17.4).

CREATE TABLE users (
  id            text PRIMARY KEY,
  username      text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role          text NOT NULL DEFAULT 'member', -- member | admin
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_sessions (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id),
  token_hash  text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz
);

CREATE TABLE projects (
  id         text PRIMARY KEY,
  owner_id   text NOT NULL REFERENCES users(id),
  slug       text NOT NULL,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, slug)
);

CREATE TABLE chat_sessions (
  id         text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id),
  owner_id   text NOT NULL REFERENCES users(id),
  title      text NOT NULL DEFAULT '新会话',
  state      text NOT NULL DEFAULT 'active',
  goal_id    text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---- goals -------------------------------------------------------------
CREATE TABLE goals (
  id              text PRIMARY KEY,
  project_id      text NOT NULL REFERENCES projects(id),
  session_id      text NOT NULL REFERENCES chat_sessions(id),
  owner_id        text NOT NULL REFERENCES users(id),
  title           text NOT NULL,
  state           text NOT NULL DEFAULT 'DRAFT',
  current_version integer NOT NULL DEFAULT 1,
  budget_cap_usd  numeric(12,4) NOT NULL DEFAULT 5.0,
  row_version     bigint NOT NULL DEFAULT 1, -- optimistic concurrency for commands
  paused_reason   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE goal_versions (
  goal_id    text NOT NULL REFERENCES goals(id),
  version    integer NOT NULL,
  objective  text NOT NULL,
  constraints jsonb NOT NULL DEFAULT '{}',
  budget_policy jsonb NOT NULL DEFAULT '{}',
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (goal_id, version)
);

-- ---- task graph ----------------------------------------------------------
CREATE TABLE graph_versions (
  id         text PRIMARY KEY,
  goal_id    text NOT NULL REFERENCES goals(id),
  version    integer NOT NULL,
  nodes      jsonb NOT NULL,
  loops      jsonb NOT NULL DEFAULT '[]',
  digest     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (goal_id, version)
);

CREATE TABLE tasks (
  id               text PRIMARY KEY,
  graph_version_id text NOT NULL REFERENCES graph_versions(id),
  goal_id          text NOT NULL REFERENCES goals(id),
  node_key         text NOT NULL,
  role             text NOT NULL,
  kind             text NOT NULL,
  title            text NOT NULL,
  instruction      text NOT NULL,
  depends_on       text[] NOT NULL DEFAULT '{}',
  input_refs       jsonb NOT NULL DEFAULT '[]',
  expected_output  text,
  risk_class       text NOT NULL DEFAULT 'low',
  state            text NOT NULL DEFAULT 'READY',
  failure_count    integer NOT NULL DEFAULT 0,
  error_fingerprint text,
  visit_count      integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (graph_version_id, node_key)
);
CREATE INDEX tasks_ready_idx ON tasks (goal_id, state) WHERE state IN ('READY','WAITING');

-- ---- attempts (run/attempt; retries append, never overwrite) ------------
CREATE TABLE attempts (
  id            text PRIMARY KEY,
  run_no        integer NOT NULL, -- logical run: attempt_no groups retries
  goal_id       text NOT NULL REFERENCES goals(id),
  task_id       text NOT NULL REFERENCES tasks(id),
  attempt_no    integer NOT NULL,
  graph_version_id text NOT NULL REFERENCES graph_versions(id),
  spec_digest   text NOT NULL,
  worker_id     text,
  status        text NOT NULL DEFAULT 'LEASED',
  lease_epoch   integer NOT NULL DEFAULT 1,
  lease_expires_at timestamptz,
  reserved_usd  numeric(12,6) NOT NULL DEFAULT 0,
  settled_usd   numeric(12,6) NOT NULL DEFAULT 0,
  unknown_usd   numeric(12,6) NOT NULL DEFAULT 0,
  model_calls   integer NOT NULL DEFAULT 0,
  error_class   text,
  heartbeat_at  timestamptz,
  started_at    timestamptz,
  ended_at      timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, attempt_no)
);
CREATE INDEX attempts_lease_idx ON attempts (status, lease_expires_at);

-- ---- event log (append-only; SSE cursor = global seq) --------------------
CREATE TABLE events (
  seq            bigserial PRIMARY KEY,
  event_id       text NOT NULL UNIQUE,
  aggregate_type text NOT NULL,
  aggregate_id   text NOT NULL,
  aggregate_seq  integer NOT NULL,
  event_type     text NOT NULL,
  goal_id        text,
  goal_version   integer,
  trace_id       text,
  causation_id   text,
  actor          jsonb,
  lease_epoch    integer,
  payload        jsonb,
  payload_ref    text,
  occurred_at    timestamptz NOT NULL,
  ingested_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (aggregate_type, aggregate_id, aggregate_seq)
);
CREATE INDEX events_goal_idx ON events (goal_id, seq);

-- ---- outbox (transactional side-effect dispatch) --------------------------
CREATE TABLE outbox (
  seq          bigserial PRIMARY KEY,
  topic        text NOT NULL,
  payload      jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'PENDING', -- PENDING|DISPATCHED|FAILED
  attempts     integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz
);

-- ---- budget ---------------------------------------------------------------
CREATE TABLE budget_reservations (
  id           text PRIMARY KEY,
  goal_id      text NOT NULL REFERENCES goals(id),
  attempt_id   text,
  scope        text NOT NULL,
  kind         text NOT NULL DEFAULT 'model', -- model|experiment|evaluation|meta
  reserved_usd numeric(12,6) NOT NULL DEFAULT 0,
  settled_usd  numeric(12,6) NOT NULL DEFAULT 0,
  unknown_usd  numeric(12,6) NOT NULL DEFAULT 0,
  status       text NOT NULL DEFAULT 'open',  -- open|settled|released
  idempotency_key text UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX budget_goal_idx ON budget_reservations (goal_id, status);

-- ---- checkpoints ------------------------------------------------------------
CREATE TABLE checkpoints (
  id          text PRIMARY KEY,
  attempt_id  text NOT NULL REFERENCES attempts(id),
  goal_id     text NOT NULL,
  task_id     text NOT NULL,
  step_index  integer NOT NULL DEFAULT 0,
  summary     text NOT NULL DEFAULT '',
  state       jsonb NOT NULL DEFAULT '{}',
  artifact_refs jsonb NOT NULL DEFAULT '[]',
  lease_epoch integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX checkpoints_attempt_idx ON checkpoints (attempt_id, created_at DESC);

-- ---- artifacts (immutable, content-addressed) ------------------------------
CREATE TABLE artifacts (
  digest      text PRIMARY KEY,
  name        text NOT NULL,
  media_type  text NOT NULL,
  size_bytes  bigint NOT NULL,
  storage_ref text NOT NULL,
  producer_run  text,
  producer_role text,
  goal_id     text,
  scope       text NOT NULL DEFAULT 'task',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---- chat ------------------------------------------------------------------
CREATE TABLE messages (
  seq        bigserial PRIMARY KEY,
  id         text NOT NULL UNIQUE,
  session_id text NOT NULL REFERENCES chat_sessions(id),
  role       text NOT NULL, -- user | agent | system
  content    text NOT NULL,
  data       jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_session_idx ON messages (session_id, seq);

-- ---- commands (accepted ≠ applied) ------------------------------------------
CREATE TABLE commands (
  id           text PRIMARY KEY,
  command_id   text NOT NULL UNIQUE,
  goal_id      text NOT NULL REFERENCES goals(id),
  kind         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'ACCEPTED', -- ACCEPTED|APPLIED|REJECTED
  expected_row_version bigint,
  actor        jsonb,
  reject_reason text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  applied_at   timestamptz
);

-- ---- steering (applies at next agent turn; ≠ interrupt) ----------------------
CREATE TABLE steers (
  id         text PRIMARY KEY,
  goal_id    text NOT NULL,
  attempt_id text,
  content    text NOT NULL,
  status     text NOT NULL DEFAULT 'PENDING', -- PENDING|DELIVERED
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);

-- ---- approvals ----------------------------------------------------------------
CREATE TABLE approvals (
  id         text PRIMARY KEY,
  goal_id    text,
  kind       text NOT NULL, -- release | budget | skill_promotion | scoring_change
  title      text NOT NULL,
  detail     jsonb NOT NULL DEFAULT '{}',
  scope      text NOT NULL DEFAULT 'project',
  status     text NOT NULL DEFAULT 'PENDING',
  requested_by text NOT NULL,
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---- evolution lineage -------------------------------------------------------
CREATE TABLE problems (
  id          text PRIMARY KEY,
  goal_id     text NOT NULL REFERENCES goals(id),
  title       text NOT NULL,
  description text NOT NULL DEFAULT '',
  failure_class text NOT NULL, -- task_misunderstanding|context_missing|tool_env|algorithm|eval_protocol
  source_refs jsonb NOT NULL DEFAULT '[]',
  status      text NOT NULL DEFAULT 'OPEN', -- OPEN|ADDRESSED|WONT_FIX
  fingerprint text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (goal_id, fingerprint)
);

CREATE TABLE change_proposals (
  id            text PRIMARY KEY,
  problem_id    text NOT NULL REFERENCES problems(id),
  goal_id       text NOT NULL,
  mechanism     text NOT NULL,
  parent_digests text[] NOT NULL DEFAULT '{}',
  allowed_paths text[] NOT NULL DEFAULT '{}',
  expected_effect text NOT NULL DEFAULT '',
  min_experiment text NOT NULL DEFAULT '',
  risks         jsonb NOT NULL DEFAULT '[]',
  rollback      text NOT NULL DEFAULT '',
  status        text NOT NULL DEFAULT 'PROPOSED',
  fingerprint   text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (goal_id, fingerprint)
);

CREATE TABLE candidates (
  id          text PRIMARY KEY,
  digest      text NOT NULL UNIQUE,
  goal_id     text NOT NULL,
  kind        text NOT NULL,
  title       text NOT NULL,
  parents     text[] NOT NULL DEFAULT '{}', -- multi-parent lineage, append-only
  artifact_digest text,
  manifest    jsonb NOT NULL DEFAULT '{}',
  status      text NOT NULL DEFAULT 'PROPOSED',
  performance jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE candidate_status_history (
  seq         bigserial PRIMARY KEY,
  candidate_id text NOT NULL REFERENCES candidates(id),
  status      text NOT NULL,
  reason      text NOT NULL DEFAULT '',
  at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE evaluations (
  id           text PRIMARY KEY,
  candidate_id text NOT NULL REFERENCES candidates(id),
  contract_version text NOT NULL,
  suite_ref    text NOT NULL,
  layer        text NOT NULL, -- dev|selection|release
  results      jsonb NOT NULL,
  verdict      text NOT NULL,
  cost_usd     numeric(12,6) NOT NULL DEFAULT 0,
  evaluated_by text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reviews (
  id           text PRIMARY KEY,
  candidate_id text NOT NULL REFERENCES candidates(id),
  reviewer     text NOT NULL,
  verdict      text NOT NULL,
  objections   jsonb NOT NULL DEFAULT '[]',
  coverage_gaps jsonb NOT NULL DEFAULT '[]',
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE releases (
  id            text PRIMARY KEY,
  goal_id       text NOT NULL,
  candidate_id  text NOT NULL REFERENCES candidates(id),
  parent_release text,
  kind          text NOT NULL, -- canary | full
  evidence_manifest jsonb NOT NULL DEFAULT '[]',
  authorization_ref text NOT NULL,
  status        text NOT NULL DEFAULT 'ACTIVE', -- ACTIVE|ROLLED_BACK
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- version pointer: CAS by (scope, parent_pointer_version)
CREATE TABLE version_pointers (
  scope        text PRIMARY KEY,
  candidate_id text NOT NULL REFERENCES candidates(id),
  release_id   text NOT NULL,
  pointer_version integer NOT NULL DEFAULT 1,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
