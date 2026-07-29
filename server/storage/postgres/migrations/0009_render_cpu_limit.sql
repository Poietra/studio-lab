ALTER TABLE public.render_sessions
  DROP CONSTRAINT render_sessions_failure_code_closed;

UPDATE public.render_sessions
   SET failure_code = 'cpu-limit'
 WHERE status IN ('failed', 'discarded')
   AND error = 'Render exceeded its CPU budget.'
   AND failure_code = 'render-failed';

ALTER TABLE public.render_sessions
  ADD CONSTRAINT render_sessions_failure_code_closed CHECK (
    failure_code IS NULL
    OR failure_code IN (
      'cancelled',
      'cpu-limit',
      'deadline-exceeded',
      'interrupted',
      'memory-limit',
      'pids-limit',
      'render-failed'
    )
  );
