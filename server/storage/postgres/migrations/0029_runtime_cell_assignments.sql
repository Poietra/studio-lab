CREATE TABLE public.runtime_cell_assignments (
  tenant_id text PRIMARY KEY,
  cell_id text NOT NULL UNIQUE CHECK (cell_id ~ '^[a-z][a-z0-9_-]{0,63}$'),
  generation bigint NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  state text NOT NULL CHECK (state IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id) REFERENCES public.organizations (tenant_id) ON DELETE RESTRICT,
  CHECK (updated_at >= created_at)
);

CREATE TABLE public.runtime_cell_assignment_mutations (
  tenant_id text NOT NULL,
  mutation_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('create', 'rotate', 'disable')),
  request_cell_id text CHECK (
    request_cell_id IS NULL OR request_cell_id ~ '^[a-z][a-z0-9_-]{0,63}$'
  ),
  expected_generation bigint CHECK (
    expected_generation IS NULL OR expected_generation BETWEEN 1 AND 9007199254740991
  ),
  result_cell_id text NOT NULL CHECK (result_cell_id ~ '^[a-z][a-z0-9_-]{0,63}$'),
  result_generation bigint NOT NULL CHECK (result_generation BETWEEN 1 AND 9007199254740991),
  result_state text NOT NULL CHECK (result_state IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, mutation_id),
  UNIQUE (tenant_id, result_generation),
  UNIQUE (tenant_id, result_cell_id, result_generation, result_state),
  FOREIGN KEY (tenant_id) REFERENCES public.runtime_cell_assignments (tenant_id) ON DELETE RESTRICT,
  CHECK (
    (
      kind = 'create'
      AND request_cell_id IS NOT NULL
      AND expected_generation IS NULL
      AND result_cell_id = request_cell_id
      AND result_generation = 1
      AND result_state = 'active'
    )
    OR (
      kind = 'rotate'
      AND request_cell_id IS NOT NULL
      AND expected_generation IS NOT NULL
      AND result_cell_id = request_cell_id
      AND result_generation = expected_generation + 1
      AND result_state = 'active'
    )
    OR (
      kind = 'disable'
      AND request_cell_id IS NULL
      AND expected_generation IS NOT NULL
      AND result_generation = expected_generation + 1
      AND result_state = 'disabled'
    )
  )
);

-- A cell ID is a server-owned allocation identity. A later rotation may free
-- its current UNIQUE slot, but must never allow another Organization (or a
-- later generation of the same Organization) to reuse that historical ID.
-- Disable records repeat the last allocated cell and are intentionally omitted.
CREATE UNIQUE INDEX runtime_cell_assignment_mutations_allocated_cell_v29
  ON public.runtime_cell_assignment_mutations (result_cell_id)
  WHERE kind IN ('create', 'rotate');

CREATE FUNCTION public.enforce_runtime_cell_assignment_transition_v29()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.generation <> 1 OR NEW.state <> 'active' THEN
      RAISE EXCEPTION 'A runtime-cell assignment must start at active generation 1.' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'A runtime-cell assignment identity is immutable.' USING ERRCODE = '23514';
  END IF;
  IF OLD.state <> 'active' THEN
    RAISE EXCEPTION 'A disabled runtime-cell assignment is terminal.' USING ERRCODE = '23514';
  END IF;
  IF NEW.generation <> OLD.generation + 1 THEN
    RAISE EXCEPTION 'A runtime-cell assignment generation must advance exactly once.' USING ERRCODE = '23514';
  END IF;
  IF NEW.state = 'active' AND NEW.cell_id = OLD.cell_id THEN
    RAISE EXCEPTION 'A runtime-cell assignment rotation requires a new cell.' USING ERRCODE = '23514';
  END IF;
  IF NEW.state = 'disabled' AND (OLD.state <> 'active' OR NEW.cell_id <> OLD.cell_id) THEN
    RAISE EXCEPTION 'A runtime-cell assignment disable must retain the active cell.' USING ERRCODE = '23514';
  END IF;

  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$function$;

CREATE TRIGGER runtime_cell_assignments_enforce_transition
BEFORE INSERT OR UPDATE ON public.runtime_cell_assignments
FOR EACH ROW
EXECUTE FUNCTION public.enforce_runtime_cell_assignment_transition_v29();

-- The current projection and immutable mutation ledger must advance together.
-- The deferred edge permits assignment-first create/update statements while
-- still rejecting a commit that omits or disagrees with its durable result.
ALTER TABLE public.runtime_cell_assignments
  ADD CONSTRAINT runtime_cell_assignments_current_mutation_v29
  FOREIGN KEY (tenant_id, cell_id, generation, state)
  REFERENCES public.runtime_cell_assignment_mutations
    (tenant_id, result_cell_id, result_generation, result_state)
  DEFERRABLE INITIALLY DEFERRED;

-- Reject a ledger entry that was not applied to the current projection in the
-- same transaction. Together with the deferred foreign key above, this makes
-- both sides of an assignment transition advance atomically.
CREATE FUNCTION public.enforce_runtime_cell_assignment_mutation_applied_v29()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.runtime_cell_assignments AS assignment
    WHERE assignment.tenant_id = NEW.tenant_id
      AND assignment.cell_id = NEW.result_cell_id
      AND assignment.generation = NEW.result_generation
      AND assignment.state = NEW.result_state
  ) THEN
    RAISE EXCEPTION 'A runtime-cell assignment mutation must be applied to the current projection.' USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$function$;

CREATE CONSTRAINT TRIGGER runtime_cell_assignment_mutations_require_projection_v29
AFTER INSERT ON public.runtime_cell_assignment_mutations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.enforce_runtime_cell_assignment_mutation_applied_v29();

CREATE FUNCTION public.reject_runtime_cell_assignment_mutation_change_v29()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  RAISE EXCEPTION 'A runtime-cell assignment mutation is immutable.' USING ERRCODE = '23514';
END;
$function$;

CREATE TRIGGER runtime_cell_assignment_mutations_immutable
BEFORE UPDATE OR DELETE ON public.runtime_cell_assignment_mutations
FOR EACH ROW
EXECUTE FUNCTION public.reject_runtime_cell_assignment_mutation_change_v29();
