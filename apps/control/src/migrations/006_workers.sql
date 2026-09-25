-- P18: worker registry — live fleet visibility.
-- Workers register implicitly: claim() upserts the row, heartbeats refresh
-- last_seen_at. GET /v1/workers derives liveness from last_seen_at vs the
-- lease TTL (no ghost rows to garbage-collect; the table stays one row per
-- worker_id ever seen).
CREATE TABLE IF NOT EXISTS workers (
  id              text PRIMARY KEY,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  claims_total    bigint NOT NULL DEFAULT 0,
  heartbeats_total bigint NOT NULL DEFAULT 0,
  last_attempt_id text,
  runtime         text
);
