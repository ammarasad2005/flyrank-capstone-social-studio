-- T0-B: durable retry with backoff + a dead-letter state on slots.

ALTER TABLE slots ADD COLUMN attempts        integer NOT NULL DEFAULT 0;
ALTER TABLE slots ADD COLUMN next_attempt_at timestamptz;   -- earliest time to retry
ALTER TABLE slots ADD COLUMN last_error      text;

-- widen the status enum to include 'dead_letter'
ALTER TABLE slots DROP CONSTRAINT slots_status_check;
ALTER TABLE slots ADD CONSTRAINT slots_status_check
  CHECK (status IN ('pending','publishing','published','failed','canceled','dead_letter'));

-- the claim now also filters on next_attempt_at
CREATE INDEX idx_slots_retry ON slots(status, scheduled_at, next_attempt_at);
