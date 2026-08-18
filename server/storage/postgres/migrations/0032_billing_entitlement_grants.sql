-- Billing v2 (ADR 0005, "Flow quota and stock quota are separate models").
-- An immutable entitlement snapshot owns normalized flow and stock grants
-- instead of one growing column set. New billing surfaces name the applied
-- entitlement stream `entitlement_generation`; the frozen v14 tables keep
-- `source_generation` as the compatibility spelling of the same counter.

CREATE TABLE public.entitlement_flow_grants (
  tenant_id text NOT NULL,
  entitlement_snapshot_id uuid NOT NULL,
  entitlement_generation bigint NOT NULL CHECK (entitlement_generation > 0),
  operation_kind text NOT NULL CHECK (
    operation_kind IN ('render', 'ai-suggestion', 'export-publication')
  ),
  usage_period_key text NOT NULL CHECK (
    usage_period_key = btrim(usage_period_key)
    AND octet_length(usage_period_key) BETWEEN 1 AND 160
    AND usage_period_key !~ '[[:cntrl:]]'
  ),
  unit_limit integer NOT NULL CHECK (unit_limit BETWEEN 0 AND 1000000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, entitlement_snapshot_id, operation_kind),
  UNIQUE (tenant_id, entitlement_snapshot_id, entitlement_generation, operation_kind, usage_period_key),
  FOREIGN KEY (tenant_id, entitlement_snapshot_id, entitlement_generation, usage_period_key)
    REFERENCES public.entitlement_snapshots (tenant_id, snapshot_id, source_generation, usage_period_key)
    ON DELETE RESTRICT
);

CREATE TABLE public.entitlement_stock_grants (
  tenant_id text NOT NULL,
  entitlement_snapshot_id uuid NOT NULL,
  entitlement_generation bigint NOT NULL CHECK (entitlement_generation > 0),
  resource_kind text NOT NULL CHECK (resource_kind = 'published-artifact-bytes'),
  quantity_limit bigint NOT NULL CHECK (quantity_limit BETWEEN 0 AND 9007199254740991),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, entitlement_snapshot_id, resource_kind),
  UNIQUE (tenant_id, entitlement_snapshot_id, entitlement_generation, resource_kind),
  FOREIGN KEY (tenant_id, entitlement_snapshot_id, entitlement_generation)
    REFERENCES public.entitlement_snapshots (tenant_id, snapshot_id, source_generation)
    ON DELETE RESTRICT
);

CREATE FUNCTION public.guard_entitlement_flow_grant_v32()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  snapshot_render_job_limit integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Entitlement flow grants are append-only.' USING ERRCODE = '23514';
  END IF;

  IF NEW.operation_kind = 'render' THEN
    SELECT snapshot.render_job_limit
      INTO snapshot_render_job_limit
      FROM public.entitlement_snapshots snapshot
     WHERE snapshot.tenant_id = NEW.tenant_id
       AND snapshot.snapshot_id = NEW.entitlement_snapshot_id;

    IF snapshot_render_job_limit IS NULL OR snapshot_render_job_limit <> NEW.unit_limit THEN
      RAISE EXCEPTION 'A render flow grant must mirror its snapshot render job limit.' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER entitlement_flow_grants_guard_mutation_v32
BEFORE INSERT OR UPDATE OR DELETE ON public.entitlement_flow_grants
FOR EACH ROW
EXECUTE FUNCTION public.guard_entitlement_flow_grant_v32();

CREATE FUNCTION public.reject_entitlement_stock_grant_mutation_v32()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  RAISE EXCEPTION 'Entitlement stock grants are append-only.' USING ERRCODE = '23514';
END;
$function$;

CREATE TRIGGER entitlement_stock_grants_append_only_v32
BEFORE UPDATE OR DELETE ON public.entitlement_stock_grants
FOR EACH ROW
EXECUTE FUNCTION public.reject_entitlement_stock_grant_mutation_v32();

-- Stock accounting is a ledger of exact allocations tied to retained
-- publications; it has no usage period key and no cached used-quantity
-- projection. `publication_id` stays a tenant-scoped identifier rather than a
-- foreign key because released audit rows deliberately outlive publication
-- metadata. Acceptance and release still update both ledgers in one transaction.
-- Expiry or logical unpublication
-- credits the tenant by setting released_at when the publication enters its
-- deletion queue; the later physical object-deletion acknowledgement is not
-- customer stock and never touches this ledger.
CREATE TABLE public.stock_allocations (
  tenant_id text NOT NULL,
  resource_kind text NOT NULL CHECK (resource_kind = 'published-artifact-bytes'),
  publication_id uuid NOT NULL,
  quantity bigint NOT NULL CHECK (quantity BETWEEN 1 AND 9007199254740991),
  allocated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  released_at timestamptz,
  PRIMARY KEY (tenant_id, resource_kind, publication_id),
  FOREIGN KEY (tenant_id) REFERENCES public.billing_accounts (tenant_id) ON DELETE RESTRICT,
  CHECK (released_at IS NULL OR released_at >= allocated_at)
);

-- Admission sums unreleased allocations under the tenant billing-account lock.
CREATE INDEX stock_allocations_unreleased_v32
  ON public.stock_allocations (tenant_id, resource_kind)
  WHERE released_at IS NULL;

CREATE FUNCTION public.guard_stock_allocation_v32()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Stock allocations are released, never deleted.' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.released_at IS NOT NULL THEN
      RAISE EXCEPTION 'A stock allocation must begin unreleased.' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR OLD.resource_kind IS DISTINCT FROM NEW.resource_kind
    OR OLD.publication_id IS DISTINCT FROM NEW.publication_id
    OR OLD.quantity IS DISTINCT FROM NEW.quantity
    OR OLD.allocated_at IS DISTINCT FROM NEW.allocated_at THEN
    RAISE EXCEPTION 'A stock allocation identity is immutable.' USING ERRCODE = '23514';
  END IF;

  IF OLD.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'A released stock allocation is immutable.' USING ERRCODE = '23514';
  END IF;

  IF NEW.released_at IS NULL THEN
    RAISE EXCEPTION 'A stock allocation update must release it.' USING ERRCODE = '23514';
  END IF;

  NEW.released_at := clock_timestamp();
  RETURN NEW;
END;
$function$;

CREATE TRIGGER stock_allocations_guard_mutation_v32
BEFORE INSERT OR UPDATE OR DELETE ON public.stock_allocations
FOR EACH ROW
EXECUTE FUNCTION public.guard_stock_allocation_v32();

-- The allocation audit row intentionally outlives publication metadata, so a
-- normal foreign key cannot express this lifecycle. These deferred constraint
-- triggers provide the referential invariant instead: a new unreleased
-- allocation must have its same-tenant publication by commit, and publication
-- deletion must release the allocation in that same transaction.
CREATE FUNCTION public.guard_stock_allocation_publication_v32()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NEW.released_at IS NULL AND NOT EXISTS (
    SELECT 1
      FROM public.client_export_publications publication
     WHERE publication.tenant_id = NEW.tenant_id
       AND publication.publication_id = NEW.publication_id
  ) THEN
    RAISE EXCEPTION 'An unreleased stock allocation requires its tenant publication.' USING ERRCODE = '23503';
  END IF;
  RETURN NULL;
END;
$function$;

CREATE CONSTRAINT TRIGGER stock_allocations_publication_v32
AFTER INSERT OR UPDATE ON public.stock_allocations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.guard_stock_allocation_publication_v32();

CREATE FUNCTION public.guard_client_export_publication_deletion_stock_v32()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.stock_allocations allocation
     WHERE allocation.tenant_id = OLD.tenant_id
       AND allocation.publication_id = OLD.publication_id
       AND allocation.released_at IS NULL
  ) THEN
    RAISE EXCEPTION 'A client export publication must release retained stock before deletion.' USING ERRCODE = '23503';
  END IF;
  RETURN NULL;
END;
$function$;

CREATE CONSTRAINT TRIGGER client_export_publications_stock_release_v32
AFTER DELETE ON public.client_export_publications
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.guard_client_export_publication_deletion_stock_v32();

-- Backfill one render flow grant from every existing v14 entitlement snapshot
-- BEFORE the operation-kind checks widen below (ADR 0005 migration order).
INSERT INTO public.entitlement_flow_grants
  (tenant_id, entitlement_snapshot_id, entitlement_generation, operation_kind, usage_period_key, unit_limit)
SELECT snapshot.tenant_id, snapshot.snapshot_id, snapshot.source_generation,
       'render', snapshot.usage_period_key, snapshot.render_job_limit
  FROM public.entitlement_snapshots snapshot;

-- Rolling compatibility: binaries that predate grant-aware entitlement
-- application still append bare snapshots. The mirror trigger keeps "every
-- entitlement snapshot owns exactly one render flow grant" structural for
-- those inserts, so the legacy render wire fields stay authoritative.
CREATE FUNCTION public.mirror_render_flow_grant_v32()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  INSERT INTO public.entitlement_flow_grants
    (tenant_id, entitlement_snapshot_id, entitlement_generation, operation_kind, usage_period_key, unit_limit)
  VALUES (NEW.tenant_id, NEW.snapshot_id, NEW.source_generation, 'render', NEW.usage_period_key, NEW.render_job_limit);
  RETURN NULL;
END;
$function$;

CREATE TRIGGER entitlement_snapshots_mirror_render_grant_v32
AFTER INSERT ON public.entitlement_snapshots
FOR EACH ROW
EXECUTE FUNCTION public.mirror_render_flow_grant_v32();

-- Widen the closed reservation/event operation-kind set only after every
-- snapshot owns its render grant. The v15 render-session trigger stays
-- render-only; new operation kinds receive constraints local to their own
-- aggregate transactions.
ALTER TABLE public.usage_reservations
  DROP CONSTRAINT usage_reservations_operation_kind_check,
  ADD CONSTRAINT usage_reservations_operation_kind_closed_v32
    CHECK (operation_kind IN ('render', 'ai-suggestion', 'export-publication'));

ALTER TABLE public.usage_events
  DROP CONSTRAINT usage_events_operation_kind_check,
  ADD CONSTRAINT usage_events_operation_kind_closed_v32
    CHECK (operation_kind IN ('render', 'ai-suggestion', 'export-publication'));

-- A reservation references its exact
-- (snapshot, entitlement generation, operation kind, usage period) grant.
ALTER TABLE public.usage_reservations
  ADD CONSTRAINT usage_reservations_flow_grant_v32
  FOREIGN KEY (tenant_id, snapshot_id, source_generation, operation_kind, usage_period_key)
  REFERENCES public.entitlement_flow_grants
    (tenant_id, entitlement_snapshot_id, entitlement_generation, operation_kind, usage_period_key)
  ON DELETE RESTRICT;
