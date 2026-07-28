import { describe, expect, it } from "vitest";

import { authenticateManimPrincipal, type VerifiedManimPrincipal } from "../manim-request-principal";
import { createEditSuggestionAdmissionController, type EditSuggestionAdmissionLimits } from "./admission";

async function principal(subjectId: string, tenantId: string): Promise<VerifiedManimPrincipal> {
  return authenticateManimPrincipal(
    { authenticate: async () => ({ subjectId, tenantId }) },
    undefined,
    new AbortController().signal,
  );
}

const HIGH_CAPACITY = {
  maxRequestsPerPrincipalWindow: 100,
  maxRequestsPerTenantWindow: 100,
  maxTrackedPrincipals: 100,
  maxTrackedTenants: 100,
  rateWindowMs: 1_000,
} as const;

describe("edit-suggestion admission", () => {
  it.each([
    ["maxConcurrentPerPrincipal", 65],
    ["maxConcurrentPerTenant", 257],
    ["maxRequestsPerPrincipalWindow", 10_001],
    ["maxRequestsPerTenantWindow", 100_001],
    ["maxTrackedPrincipals", 65_537],
    ["maxTrackedTenants", 4_097],
    ["rateWindowMs", 3_600_001],
  ] as const)("rejects an effectively unbounded %s", (name, value) => {
    expect(() =>
      createEditSuggestionAdmissionController({
        limits: { [name]: value } as Partial<EditSuggestionAdmissionLimits>,
      }),
    ).toThrow(/no greater than/i);
  });

  it("enforces principal and tenant concurrency atomically and releases idempotently", async () => {
    const [first, second, third] = await Promise.all([
      principal("user-a", "tenant-a"),
      principal("user-b", "tenant-a"),
      principal("user-c", "tenant-a"),
    ]);
    const admission = createEditSuggestionAdmissionController({
      correlationSecret: new Uint8Array(32).fill(7),
      limits: {
        ...HIGH_CAPACITY,
        maxConcurrentPerPrincipal: 1,
        maxConcurrentPerTenant: 2,
      },
    });

    const firstReservation = admission.reserve(first);
    expect(firstReservation.accepted).toBe(true);
    expect(admission.reserve(first)).toEqual({ accepted: false });
    const secondReservation = admission.reserve(second);
    expect(secondReservation.accepted).toBe(true);
    expect(admission.reserve(third)).toEqual({ accepted: false });

    if (!firstReservation.accepted || !secondReservation.accepted) throw new Error("Expected reservations.");
    firstReservation.reservation.release();
    firstReservation.reservation.release();
    expect(admission.reserve(third).accepted).toBe(true);
    secondReservation.reservation.release();
  });

  it("enforces rate windows independently for one principal and its tenant", async () => {
    let now = 10_000;
    const [first, second, third] = await Promise.all([
      principal("user-a", "tenant-a"),
      principal("user-b", "tenant-a"),
      principal("user-c", "tenant-a"),
    ]);
    const admission = createEditSuggestionAdmissionController({
      limits: {
        maxConcurrentPerPrincipal: 2,
        maxConcurrentPerTenant: 4,
        maxRequestsPerPrincipalWindow: 2,
        maxRequestsPerTenantWindow: 3,
        maxTrackedPrincipals: 10,
        maxTrackedTenants: 10,
        rateWindowMs: 1_000,
      },
      now: () => now,
    });

    for (let request = 0; request < 2; request += 1) {
      const admitted = admission.reserve(first);
      expect(admitted.accepted).toBe(true);
      if (admitted.accepted) admitted.reservation.release();
    }
    expect(admission.reserve(first)).toEqual({ accepted: false });
    const tenantCapacity = admission.reserve(second);
    expect(tenantCapacity.accepted).toBe(true);
    if (tenantCapacity.accepted) tenantCapacity.reservation.release();
    expect(admission.reserve(third)).toEqual({ accepted: false });

    now += 1_000;
    expect(admission.reserve(first).accepted).toBe(true);
  });

  it("bounds tracked scopes and emits stable opaque correlations", async () => {
    let now = 0;
    const [first, second] = await Promise.all([
      principal("user-readable-a", "tenant-readable"),
      principal("user-readable-b", "tenant-readable"),
    ]);
    const admission = createEditSuggestionAdmissionController({
      correlationSecret: new Uint8Array(32).fill(11),
      limits: {
        ...HIGH_CAPACITY,
        maxConcurrentPerPrincipal: 2,
        maxConcurrentPerTenant: 2,
        maxTrackedPrincipals: 1,
        maxTrackedTenants: 1,
      },
      now: () => now,
    });

    const firstReservation = admission.reserve(first);
    expect(firstReservation.accepted).toBe(true);
    if (!firstReservation.accepted) throw new Error("Expected a reservation.");
    firstReservation.reservation.release();
    expect(admission.reserve(second)).toEqual({ accepted: false });

    const correlations = admission.correlations(first);
    expect(correlations).toEqual(admission.correlations(first));
    expect(correlations.principalCorrelation).toMatch(/^[0-9a-f]{24}$/);
    expect(correlations.tenantCorrelation).toMatch(/^[0-9a-f]{24}$/);
    expect(JSON.stringify(correlations)).not.toMatch(/tenant-readable|user-readable/);

    now += 1_000;
    expect(admission.reserve(second).accepted).toBe(true);
  });
});
