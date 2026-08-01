ALTER TABLE public.render_sessions
  ADD CONSTRAINT render_sessions_scene_name_v19
    CHECK (scene_name ~ '^[A-Za-z_][A-Za-z0-9_]*$' AND char_length(scene_name) <= 240)
    NOT VALID;

ALTER TABLE public.render_sessions
  VALIDATE CONSTRAINT render_sessions_scene_name_v19;

ALTER TABLE public.render_sessions
  DROP CONSTRAINT render_sessions_scene_name_check;
