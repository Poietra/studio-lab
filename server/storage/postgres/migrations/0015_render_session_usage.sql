CREATE FUNCTION public.require_render_session_usage_state_v15()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  current_status text;
  reservation_state text;
BEGIN
  SELECT session.status
    INTO current_status
    FROM public.render_sessions session
   WHERE session.tenant_id = NEW.tenant_id
     AND session.session_id = NEW.session_id;

  -- A session deleted later in the same transaction has no durable billing state to validate.
  IF current_status IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT reservation.state
    INTO reservation_state
    FROM public.usage_reservations reservation
   WHERE reservation.tenant_id = NEW.tenant_id
     AND reservation.operation_kind = 'render'
     AND reservation.operation_id = NEW.session_id;

  IF reservation_state IS NULL THEN
    -- Rows that predate usage reservations remain mutable after the guarded cutover.
    -- Every post-v15 INSERT still has its own deferred INSERT event and fails below.
    IF TG_OP = 'UPDATE' THEN
      RETURN NULL;
    END IF;

    RAISE EXCEPTION 'A new render session requires its render usage reservation.'
      USING ERRCODE = '23514';
  END IF;

  IF (current_status IN ('preparing', 'rendering') AND reservation_state <> 'reserved')
    OR (current_status IN ('ready', 'committed', 'undone') AND reservation_state <> 'committed')
    OR (current_status IN ('cancelled', 'failed') AND reservation_state <> 'released')
    OR (current_status = 'discarded' AND reservation_state NOT IN ('committed', 'released')) THEN
    RAISE EXCEPTION 'A render session status requires a matching usage reservation state.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$function$;

CREATE CONSTRAINT TRIGGER render_sessions_require_usage_state_v15
AFTER INSERT OR UPDATE OF status ON public.render_sessions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.require_render_session_usage_state_v15();
