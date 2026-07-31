CREATE TABLE public.oidc_login_attempts (
  state_hash bytea PRIMARY KEY CHECK (octet_length(state_hash) = 32),
  browser_binding_hash bytea NOT NULL CHECK (octet_length(browser_binding_hash) = 32),
  code_verifier text NOT NULL CHECK (
    char_length(code_verifier) BETWEEN 43 AND 128
    AND code_verifier ~ '^[A-Za-z0-9._~-]+$'
  ),
  nonce text NOT NULL CHECK (
    char_length(nonce) BETWEEN 16 AND 255
    AND nonce ~ '^[A-Za-z0-9_-]+$'
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  CHECK (
    expires_at > created_at
    AND expires_at <= created_at + interval '10 minutes'
  )
);

CREATE INDEX oidc_login_attempts_expiry
  ON public.oidc_login_attempts (expires_at);

ALTER TABLE public.account_sessions
  ADD CONSTRAINT account_sessions_bounded_lifetime_v13
  CHECK (expires_at <= created_at + interval '30 days');
