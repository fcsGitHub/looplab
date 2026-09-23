-- LoopLab schema 003: attempt spec snapshots & tool result log.

-- Frozen RunSpec snapshot per attempt (the authority for tool gating).
CREATE TABLE attempt_specs (
  attempt_id   text PRIMARY KEY REFERENCES attempts(id),
  spec         jsonb NOT NULL,
  allowed_tools jsonb NOT NULL,
  workspace_dir text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Tool execution results reported by workers (audit + late-result checks).
CREATE TABLE tool_results (
  attempt_id  text NOT NULL REFERENCES attempts(id),
  seq         integer NOT NULL,
  tool        text NOT NULL,
  ok          boolean NOT NULL,
  output_digest text,
  output_bytes  integer NOT NULL DEFAULT 0,
  duration_ms integer NOT NULL DEFAULT 0,
  lease_epoch integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (attempt_id, seq)
);
