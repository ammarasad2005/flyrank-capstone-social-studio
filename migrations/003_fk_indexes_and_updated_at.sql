-- T0-A closeout: cover every existing foreign-key lookup/delete path and make
-- updated_at reliable even for updates that bypass the repository layer.
CREATE INDEX IF NOT EXISTS idx_slots_variant ON slots (variant_id);
CREATE INDEX IF NOT EXISTS idx_attempts_variant ON publish_attempts (variant_id);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER variants_set_updated_at
BEFORE UPDATE ON variants
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER publish_attempts_set_updated_at
BEFORE UPDATE ON publish_attempts
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
