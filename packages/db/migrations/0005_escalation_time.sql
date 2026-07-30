-- Escalations need their own timestamp.
--
-- Ordering "newest first" previously fell back to the parent conversation's created_at,
-- which is exact per conversation and wrong across several escalations within one. The
-- escalations table is what an owner reads to decide what content to write next, and a
-- list in the wrong order sends them to the oldest gap first.
--
-- DEFAULT now() so existing rows get a value rather than sorting as null, and NOT NULL so
-- a future insert cannot omit it and reintroduce the same ambiguity.
ALTER TABLE escalations ADD COLUMN occurred_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX escalations_time_idx ON escalations (tenant_id, occurred_at DESC);
