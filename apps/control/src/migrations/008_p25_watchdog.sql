-- 008 (P25): hot-path indexes, attempt summaries (A2A handoff), and the
-- budget idempotency-replay column (V23).

-- hot paths that scanned: goal detail/attempts list/report (goal_id),
-- heartbeats polling steers, tool-result seq assignment, attempt_no bump
CREATE INDEX IF NOT EXISTS attempts_goal_idx ON attempts (goal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS attempts_task_idx ON attempts (task_id, attempt_no);
CREATE INDEX IF NOT EXISTS tool_results_attempt_idx ON tool_results (attempt_id, seq);
CREATE INDEX IF NOT EXISTS steers_goal_attempt_idx ON steers (goal_id, attempt_id, status);

-- A2A handoff: the successor agent receives the predecessor's RESULT summary;
-- store it on the attempt row so the scheduler can resolve it cheaply
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS summary text NOT NULL DEFAULT '';

-- V23: a reused idempotency key must REPLAY the recorded response instead of
-- performing a fresh billable call whose settlement overwrites the first one
ALTER TABLE budget_reservations ADD COLUMN IF NOT EXISTS response jsonb;
