import { HttpError } from "./http/json";
import type { ManimTenantStorageBoundary } from "./manim-api";
import { isVerifiedManimPrincipal, manimTenantIdSchema, type VerifiedManimPrincipal } from "./manim-request-principal";
import { manimStorageRootsOverlap, validateManimStorageRoots } from "./manim-tenant-storage";

type TenantApi = Readonly<{
  storageBoundary?: ManimTenantStorageBoundary;
  storageRoots?: readonly string[];
  tenantId: string;
}>;

/**
 * Keeps resource namespaces partitioned by tenant. Callers cannot look
 * up an API by a client-supplied tenant ID; selection only accepts a verified
 * principal created by the authentication boundary.
 */
export class ManimTenantRegistry<Api extends TenantApi> {
  private readonly tenants = new Map<string, Api>();

  private storageBoundary(api: Api): ManimTenantStorageBoundary {
    const candidate = api as Readonly<{ storageBoundary?: unknown; storageRoots?: unknown }>;
    if (candidate.storageBoundary !== undefined) {
      if (candidate.storageRoots !== undefined) {
        throw new TypeError("A tenant API must declare exactly one storage boundary.");
      }
      if (
        typeof candidate.storageBoundary !== "object" ||
        candidate.storageBoundary === null ||
        !("kind" in candidate.storageBoundary) ||
        candidate.storageBoundary.kind !== "shared-durable" ||
        !("namespace" in candidate.storageBoundary) ||
        typeof candidate.storageBoundary.namespace !== "string" ||
        !/^[a-z][a-z0-9._-]{0,127}$/.test(candidate.storageBoundary.namespace)
      ) {
        throw new TypeError("The shared durable storage namespace is invalid.");
      }
      return { kind: "shared-durable", namespace: candidate.storageBoundary.namespace };
    }
    return { kind: "host-paths", roots: validateManimStorageRoots(candidate.storageRoots) };
  }

  private assertStorageIsolation() {
    const entries = [...this.tenants.values()];
    for (let firstIndex = 0; firstIndex < entries.length; firstIndex += 1) {
      for (let secondIndex = firstIndex + 1; secondIndex < entries.length; secondIndex += 1) {
        const first = this.storageBoundary(entries[firstIndex]!);
        const second = this.storageBoundary(entries[secondIndex]!);
        if (
          first.kind === "host-paths" &&
          second.kind === "host-paths" &&
          manimStorageRootsOverlap(first.roots, second.roots)
        ) {
          throw new TypeError("Tenant storage roots must not overlap.");
        }
      }
    }
  }

  private assertSelectedStorageIsolation(selected: Api) {
    const selectedBoundary = this.storageBoundary(selected);
    for (const api of this.tenants.values()) {
      const otherBoundary = this.storageBoundary(api);
      if (
        api !== selected &&
        selectedBoundary.kind === "host-paths" &&
        otherBoundary.kind === "host-paths" &&
        manimStorageRootsOverlap(selectedBoundary.roots, otherBoundary.roots)
      ) {
        throw new TypeError("Tenant storage roots must not overlap.");
      }
    }
  }

  constructor(apis: readonly Api[]) {
    if (apis.length > 1_024) throw new TypeError("The tenant registry accepts at most 1024 tenants.");
    for (const api of apis) {
      const parsedTenantId = manimTenantIdSchema.safeParse(api.tenantId);
      if (!parsedTenantId.success) throw new TypeError("The tenant registry received an invalid tenant ID.");
      this.storageBoundary(api);
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
