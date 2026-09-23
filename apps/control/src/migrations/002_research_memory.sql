-- LoopLab schema 002: research assets, memory & skills, optimizer registry (P4/P6).

-- ---- research ---------------------------------------------------------------
CREATE TABLE hypotheses (
  id            text PRIMARY KEY,
  goal_id       text NOT NULL REFERENCES goals(id),
  statement     text NOT NULL,
  mechanism     text NOT NULL DEFAULT '',
  applicability text NOT NULL DEFAULT '',   -- 适用条件
  baseline_ref  text,
  key_variable  text NOT NULL DEFAULT '',
  invalid_conditions text NOT NULL DEFAULT '',
  primary_metric text NOT NULL DEFAULT '',
  min_effect    numeric(12,6),
  falsifier     text NOT NULL DEFAULT '',
  next_step     text NOT NULL DEFAULT '',
  stage         text NOT NULL DEFAULT 'S0',
  state         text NOT NULL DEFAULT 'PROPOSED',
  verdict       text,        -- implementation_failed|insufficient_power|out_of_regime|falsified_in_scope|supported_in_scope
  revive_condition text NOT NULL DEFAULT '',
  evidence_refs jsonb NOT NULL DEFAULT '[]',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE experiment_plans (
  id            text PRIMARY KEY,
  hypothesis_id text NOT NULL REFERENCES hypotheses(id),
  protocol      jsonb NOT NULL,           -- frozen before results are seen
  analysis_plan jsonb NOT NULL DEFAULT '{}',
  control_group jsonb NOT NULL DEFAULT '{}',
  repetitions   integer NOT NULL DEFAULT 1,
  seeds         jsonb NOT NULL DEFAULT '[]',
  status        text NOT NULL DEFAULT 'FROZEN', -- FROZEN|RUNNING|DONE
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE experiment_runs (
  id            text PRIMARY KEY,
  plan_id       text NOT NULL REFERENCES experiment_plans(id),
  arm           text NOT NULL,            -- treatment|control
  seed          integer NOT NULL,
  params        jsonb NOT NULL DEFAULT '{}',
  result        jsonb,
  metrics       jsonb NOT NULL DEFAULT '{}',
  runtime_ms    integer,
  status        text NOT NULL DEFAULT 'PENDING', -- PENDING|DONE|FAILED
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---- claims & sources --------------------------------------------------------
CREATE TABLE sources (
  id         text PRIMARY KEY,
  goal_id    text,
  locator    text NOT NULL,
  title      text NOT NULL DEFAULT '',
  kind       text NOT NULL DEFAULT 'web',   -- web|paper|repo|dataset
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE claims (
  id           text PRIMARY KEY,
  goal_id      text NOT NULL,
  text         text NOT NULL,
  stance       text NOT NULL,  -- 条件内支持|证据不足|条件内否定|已被反证
  scope        text NOT NULL,
  kind         text NOT NULL DEFAULT 'measured', -- citation|inference|measured
  evidence_refs jsonb NOT NULL DEFAULT '[]',
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ---- memory: four stores (design §13.1) ----------------------------------------
CREATE TABLE memories (
  id         text PRIMARY KEY,
  goal_id    text,
  kind       text NOT NULL, -- working|episodic|semantic|skill
  content    text NOT NULL,
  refs       jsonb NOT NULL DEFAULT '[]',
  utility    numeric(8,4) NOT NULL DEFAULT 0,   -- observed usefulness, MemRL-style
  scope      text NOT NULL DEFAULT 'project',
  status     text NOT NULL DEFAULT 'active',    -- active|candidate|retired|quarantined
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memories_kind_idx ON memories (kind, scope, status);

CREATE TABLE skills (
  id           text PRIMARY KEY,
  name         text NOT NULL,
  version      text NOT NULL,
  status       text NOT NULL DEFAULT 'candidate', -- candidate|project|team|retired
  scope        text NOT NULL DEFAULT 'project',
  procedure_ref text,
  executable_ref text,
  applicability jsonb NOT NULL DEFAULT '{}',   -- requires/excludes
  evidence_refs jsonb NOT NULL DEFAULT '[]',
  counterexample_refs jsonb NOT NULL DEFAULT '[]',
  parent_versions text[] NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name, version)
);

-- ---- optimizer registry (meta-evolution, design §09) ----------------------------
CREATE TABLE optimizers (
  id         text PRIMARY KEY,
  name       text NOT NULL,
  impl       text NOT NULL,        -- simple-baseline | geppa-port | ...
  epoch      integer NOT NULL DEFAULT 1,
  status     text NOT NULL DEFAULT 'ACTIVE', -- ACTIVE|FROZEN|CANDIDATE|RETIRED
  config     jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE meta_evaluations (
  id            text PRIMARY KEY,
  goal_id       text NOT NULL,
  old_optimizer text NOT NULL,
  new_optimizer text NOT NULL,
  task_families jsonb NOT NULL DEFAULT '[]',
  budget_usd    numeric(12,6) NOT NULL,
  old_gain      numeric(12,6),
  new_gain      numeric(12,6),
  verdict       text NOT NULL DEFAULT 'PENDING', -- PENDING|SWITCH_NEXT_EPOCH|REJECTED
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---- settings (model/worker config; secrets never returned to UI) ---------------
CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
