-- OptimizerPort runtime state (design §5.3, §6.8):
--   optimizer_epochs  — frozen optimizer lineage; the active backend may only
--                       change via a sanctioned equal-budget epoch trial, and
--                       the switch takes effect for the NEXT epoch only.
--   optimizer_runs    — one backend execution; carries an opaque run token
--                       (hash-stored) that authorizes the metered LLM proxy.
-- Optimizer proposals originate from population search, not a single failure
-- problem, so problem_id becomes nullable (lineage stays in proposal.created
-- payloads under optimizer_run).
ALTER TABLE change_proposals ALTER COLUMN problem_id DROP NOT NULL;

CREATE TABLE IF NOT EXISTS optimizer_epochs (
  index INTEGER PRIMARY KEY,
  active_backend TEXT NOT NULL,
  frozen JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','TRIAL_RUNNING','CLOSED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS optimizer_runs (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(id),
  backend TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('active','epoch_trial')),
  epoch_index INTEGER NOT NULL REFERENCES optimizer_epochs(index),
  status TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','COMPLETED','FAILED','EXPIRED')),
  token_hash TEXT NOT NULL UNIQUE,
  budget_max_metric_calls INTEGER NOT NULL,
  budget_max_llm_cost_usd NUMERIC(12,6) NOT NULL DEFAULT 0,
  spent_usd NUMERIC(12,6) NOT NULL DEFAULT 0,
  llm_calls INTEGER NOT NULL DEFAULT 0,
  metric_calls INTEGER NOT NULL DEFAULT 0,
  manifest JSONB NOT NULL DEFAULT '{}',
  stopped_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_optimizer_runs_goal ON optimizer_runs(goal_id, created_at);

INSERT INTO optimizer_epochs (index, active_backend, frozen)
VALUES (0, 'simple-baseline@1', '{"kernel_version":"v1","suite_family":"algorithm-search.bin-packing","seed_archive":42}')
ON CONFLICT (index) DO NOTHING;
