-- Problem ledger #3: priority scheduling.
-- priority 1 = most urgent .. 9 = least urgent (P0..P9 style, default 5).
-- The claim query orders by (priority, created_at): urgent goals preempt
-- backlog; FIFO still holds within a single priority tier. Priority is
-- goal-level intent; tasks inherit it through the claim-time join, so a
-- revision never has to re-stamp task rows.
ALTER TABLE goals ADD COLUMN priority smallint NOT NULL DEFAULT 5;
ALTER TABLE goals ADD CONSTRAINT goals_priority_range CHECK (priority BETWEEN 1 AND 9);
