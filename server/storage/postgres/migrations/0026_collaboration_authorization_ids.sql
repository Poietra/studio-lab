ALTER TABLE public.account_sessions
  ADD COLUMN authorization_id uuid NOT NULL DEFAULT gen_random_uuid();

ALTER TABLE public.account_sessions
  ADD CONSTRAINT account_sessions_authorization_id_unique_v26 UNIQUE (authorization_id);
