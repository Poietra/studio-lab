CREATE TABLE public.account_organization_switch_mutations (
  session_token_hash bytea NOT NULL CHECK (octet_length(session_token_hash) = 32),
  mutation_id uuid NOT NULL,
  organization_id text NOT NULL,
  expected_version bigint NOT NULL CHECK (expected_version > 0),
  resulting_version bigint NOT NULL CHECK (resulting_version > expected_version),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (session_token_hash, mutation_id),
  UNIQUE (session_token_hash, resulting_version),
  FOREIGN KEY (session_token_hash)
    REFERENCES public.account_sessions (session_token_hash) ON DELETE CASCADE
);
