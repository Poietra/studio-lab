import { HttpError } from "./http/json";
import { isVerifiedManimPrincipal, manimTenantIdSchema, type VerifiedManimPrincipal } from "./manim-request-principal";
import { manimStorageRootsOverlap, validateManimStorageRoots } from "./manim-tenant-storage";

type TenantApi = Readonly<{ storageRoots: readonly string[]; tenantId: string }>;

/**
 * Keeps resource namespaces partitioned by tenant. Callers cannot look
 * up an API by a client-supplied tenant ID; selection only accepts a verified
 * principal created by the authentication boundary.
 */
export class ManimTenantRegistry<Api extends TenantApi> {
  private readonly tenants = new Map<string, Api>();

  private storageRoots(api: Api) {
    return validateManimStorageRoots((api as Readonly<{ storageRoots?: unknown }>).storageRoots);
  }

  private assertStorageIsolation() {
    const entries = [...this.tenants.values()];
    for (let firstIndex = 0; firstIndex < entries.length; firstIndex += 1) {
      for (let secondIndex = firstIndex + 1; secondIndex < entries.length; secondIndex += 1) {
        if (
          manimStorageRootsOverlap(this.storageRoots(entries[firstIndex]!), this.storageRoots(entries[secondIndex]!))
        ) {
          throw new TypeError("Tenant storage roots must not overlap.");
        }
      }
    }
  }

  private assertSelectedStorageIsolation(selected: Api) {
    for (const api of this.tenants.values()) {
      if (api !== selected && manimStorageRootsOverlap(this.storageRoots(selected), this.storageRoots(api))) {
        throw new TypeError("Tenant storage roots must not overlap.");
      }
    }
  }

  constructor(apis: readonly Api[]) {
    if (apis.length > 1_024) throw new TypeError("The tenant registry accepts at most 1024 tenants.");
    for (const api of apis) {
      const parsedTenantId = manimTenantIdSchema.safeParse(api.tenantId);
      if (!parsedTenantId.success) throw new TypeError("The tenant registry received an invalid tenant ID.");
      this.storageRoots(api);
      if (this.tenants.has(parsedTenantId.data)) throw new TypeError("Duplicate tenant registry entry.");
      this.tenants.set(parsedTenantId.data, api);
    }
    this.assertStorageIsolation();
  }

  forPrincipal(principal: VerifiedManimPrincipal): Api {
    if (!isVerifiedManimPrincipal(principal)) throw new HttpError("Authentication is required.", 401);
    const api = this.tenants.get(principal.tenantId);
    if (!api) throw new HttpError("Tenant access is not available.", 403);
    try {
      this.assertSelectedStorageIsolation(api);
    } catch {
      throw new HttpError("Tenant storage isolation is unavailable.", 503);
    }
    return api;
  }
}
