CREATE INDEX organization_invitations_issuance_window_v24
  ON public.organization_invitations (tenant_id, created_at, created_by);
