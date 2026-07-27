import type { ManimApi, ManimRequestContext } from "./manim-render-http";
import { createTrustedLocalManimPrincipal } from "./manim-request-principal";
import { ManimTenantRegistry } from "./manim-tenant-registry";

export function createTrustedLocalManimRequestContext(
  api: ManimApi,
  deployment: "desktop" | "development" | "test",
): ManimRequestContext {
  return {
    principal: createTrustedLocalManimPrincipal({ deployment, tenantId: api.tenantId }),
    tenants: new ManimTenantRegistry<ManimApi>([api]),
  };
}
