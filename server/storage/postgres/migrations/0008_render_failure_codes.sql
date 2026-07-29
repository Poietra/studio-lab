ALTER TABLE public.render_sessions
  ADD COLUMN failure_code text;

UPDATE public.render_sessions
   SET failure_code = CASE
     WHEN status = 'cancelled' THEN 'cancelled'
     WHEN status IN ('failed', 'discarded')
       AND error = 'Render execution deadline exceeded.' THEN 'deadline-exceeded'
     WHEN status IN ('failed', 'discarded')
       AND error = 'Render execution was interrupted.' THEN 'interrupted'
     WHEN status IN ('failed', 'discarded')
       AND error = 'Render exceeded its memory limit.' THEN 'memory-limit'
     WHEN status IN ('failed', 'discarded')
       AND error = 'Render exceeded its process limit.' THEN 'pids-limit'
     WHEN status = 'failed' THEN 'render-failed'
     WHEN status = 'discarded' AND error IS NOT NULL THEN 'render-failed'
     ELSE NULL
   END
 WHERE status IN ('cancelled', 'failed')
    OR (status = 'discarded' AND error IS NOT NULL);

CREATE FUNCTION public.normalize_render_session_failure_code_v8()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NEW.failure_code IS NULL THEN
    NEW.failure_code := CASE
      WHEN NEW.status = 'cancelled' THEN 'cancelled'
      WHEN NEW.status IN ('failed', 'discarded')
        AND NEW.error = 'Render execution deadline exceeded.' THEN 'deadline-exceeded'
      WHEN NEW.status IN ('failed', 'discarded')
        AND NEW.error = 'Render execution was interrupted.' THEN 'interrupted'
      WHEN NEW.status IN ('failed', 'discarded')
        AND NEW.error = 'Render exceeded its memory limit.' THEN 'memory-limit'
      WHEN NEW.status IN ('failed', 'discarded')
        AND NEW.error = 'Render exceeded its process limit.' THEN 'pids-limit'
      WHEN NEW.status = 'failed' THEN 'render-failed'
      WHEN NEW.status = 'discarded' AND NEW.error IS NOT NULL THEN 'render-failed'
      ELSE NULL
    END;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER render_sessions_failure_code_normalization
BEFORE INSERT OR UPDATE OF status, error, failure_code ON public.render_sessions
FOR EACH ROW
EXECUTE FUNCTION public.normalize_render_session_failure_code_v8();

ALTER TABLE public.render_sessions
  ADD CONSTRAINT render_sessions_failure_code_closed CHECK (
    failure_code IS NULL
    OR failure_code IN (
      'cancelled',
      'deadline-exceeded',
      'interrupted',
      'memory-limit',
      'pids-limit',
      'render-failed'
    )
  ),
  ADD CONSTRAINT render_sessions_failure_code_status CHECK (
    (failure_code IS NULL AND status NOT IN ('cancelled', 'failed'))
    OR status = 'discarded'
    OR (status = 'cancelled' AND failure_code IS NOT NULL AND failure_code = 'cancelled')
    OR (status = 'failed' AND failure_code IS NOT NULL AND failure_code <> 'cancelled')
  );
