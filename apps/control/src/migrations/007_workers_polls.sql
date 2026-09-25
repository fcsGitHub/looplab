-- P18 fix: claims_total was incremented on EVERY claim poll, so it measured
-- poll volume, not granted work. 007 adds polls_total for poll volume and
-- repurposes claims_total strictly for granted claims (bumped only when an
-- attempt is actually created).
ALTER TABLE workers ADD COLUMN IF NOT EXISTS polls_total bigint NOT NULL DEFAULT 0;
