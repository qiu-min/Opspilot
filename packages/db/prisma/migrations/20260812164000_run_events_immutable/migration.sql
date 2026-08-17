CREATE OR REPLACE FUNCTION prevent_run_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'run_events are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER run_events_prevent_update
BEFORE UPDATE ON "run_events"
FOR EACH ROW EXECUTE FUNCTION prevent_run_event_mutation();

CREATE TRIGGER run_events_prevent_delete
BEFORE DELETE ON "run_events"
FOR EACH ROW EXECUTE FUNCTION prevent_run_event_mutation();
