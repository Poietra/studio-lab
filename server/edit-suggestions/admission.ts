import { createHmac, randomBytes } from "node:crypto";

import { isVerifiedManimPrincipal, type VerifiedManimPrincipal } from "../manim-request-principal";

export type EditSuggestionAdmissionLimits = Readonly<{
  maxConcurrentPerPrincipal: number;
  maxConcurrentPerTenant: number;
  maxRequestsPerPrincipalWindow: number;
  maxRequestsPerTenantWindow: number;
  maxTrackedPrincipals: number;
  maxTrackedTenants: number;
  rateWindowMs: number;
}>;

export type EditSuggestionGenerationReservation = Readonly<{
  release: () => void;
}>;

export type EditSuggestionGenerationAdmissionResult =
  | Readonly<{
      accepted: false;
    }>
  | Readonly<{
      accepted: true;
      reservation: EditSuggestionGenerationReservation;
    }>;

type ScopeState = {
  active: number;
  requests: number;
  windowStartedAt: number;
};

type ScopeLookup = Readonly<{
  now: number;
  principalKey: string;
  principalState: ScopeState | undefined;
  tenantState: ScopeState | undefined;
}>;

const DEFAULT_LIMITS: EditSuggestionAdmissionLimits = Object.freeze({
  maxConcurrentPerPrincipal: 2,
  maxConcurrentPerTenant: 8,
  maxRequestsPerPrincipalWindow: 20,
  maxRequestsPerTenantWindow: 100,
  maxTrackedPrincipals: 4_096,
  maxTrackedTenants: 1_024,
  rateWindowMs: 60_000,
});

const MAX_LIMITS: EditSuggestionAdmissionLimits = Object.freeze({
  maxConcurrentPerPrincipal: 64,
  maxConcurrentPerTenant: 256,
  maxRequestsPerPrincipalWindow: 10_000,
  maxRequestsPerTenantWindow: 100_000,
  maxTrackedPrincipals: 65_536,
  maxTrackedTenants: 4_096,
  rateWindowMs: 60 * 60 * 1_000,
});

function boundedPositiveInteger(value: number, name: string, maximum: number) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${name} must be a positive integer no greater than ${maximum}.`);
  }
  return value;
}

function parseLimits(input: Partial<EditSuggestionAdmissionLimits> = {}): EditSuggestionAdmissionLimits {
  const limits = { ...DEFAULT_LIMITS, ...input };
  return Object.freeze({
    maxConcurrentPerPrincipal: boundedPositiveInteger(
      limits.maxConcurrentPerPrincipal,
      "maxConcurrentPerPrincipal",
      MAX_LIMITS.maxConcurrentPerPrincipal,
    ),
    maxConcurrentPerTenant: boundedPositiveInteger(
      limits.maxConcurrentPerTenant,
      "maxConcurrentPerTenant",
      MAX_LIMITS.maxConcurrentPerTenant,
    ),
    maxRequestsPerPrincipalWindow: boundedPositiveInteger(
      limits.maxRequestsPerPrincipalWindow,
      "maxRequestsPerPrincipalWindow",
      MAX_LIMITS.maxRequestsPerPrincipalWindow,
    ),
    maxRequestsPerTenantWindow: boundedPositiveInteger(
      limits.maxRequestsPerTenantWindow,
      "maxRequestsPerTenantWindow",
      MAX_LIMITS.maxRequestsPerTenantWindow,
    ),
    maxTrackedPrincipals: boundedPositiveInteger(
      limits.maxTrackedPrincipals,
      "maxTrackedPrincipals",
      MAX_LIMITS.maxTrackedPrincipals,
    ),
    maxTrackedTenants: boundedPositiveInteger(
      limits.maxTrackedTenants,
      "maxTrackedTenants",
      MAX_LIMITS.maxTrackedTenants,
    ),
    rateWindowMs: boundedPositiveInteger(limits.rateWindowMs, "rateWindowMs", MAX_LIMITS.rateWindowMs),
  });
}

function principalScope(principal: VerifiedManimPrincipal) {
  return `${principal.tenantId}\0${principal.subjectId}`;
}

/**
 * Owns the small in-process admission boundary for the edit-suggestion model.
 * Production callers still need a distributed limit at their edge, but every
 * Studio process consumes request quota before body parsing and separately
 * enforces generation concurrency before it calls the provider.
 */
export class EditSuggestionAdmissionController {
  readonly #correlationSecret: Uint8Array;
  readonly #limits: EditSuggestionAdmissionLimits;
  readonly #now: () => number;
  readonly #principals = new Map<string, ScopeState>();
  readonly #tenants = new Map<string, ScopeState>();

  constructor(
    options: Readonly<{
      correlationSecret?: Uint8Array;
      limits?: Partial<EditSuggestionAdmissionLimits>;
      now?: () => number;
    }> = {},
  ) {
    this.#limits = parseLimits(options.limits);
    this.#now = options.now ?? Date.now;
    this.#correlationSecret = options.correlationSecret ? Uint8Array.from(options.correlationSecret) : randomBytes(32);
    if (this.#correlationSecret.byteLength < 16 || this.#correlationSecret.byteLength > 64) {
      throw new RangeError("The edit-suggestion correlation secret must contain 16 to 64 bytes.");
    }
  }

  #refresh(state: ScopeState, now: number) {
    if (now - state.windowStartedAt < this.#limits.rateWindowMs) return;
    state.requests = 0;
    state.windowStartedAt = now;
  }

  #removeExpiredInactive(scopes: Map<string, ScopeState>, now: number) {
    for (const [key, state] of scopes) {
      if (state.active === 0 && now - state.windowStartedAt >= this.#limits.rateWindowMs) scopes.delete(key);
    }
  }

  #correlation(kind: "principal" | "tenant", value: string) {
    return createHmac("sha256", this.#correlationSecret)
      .update(kind, "utf8")
      .update("\0", "utf8")
      .update(value, "utf8")
      .digest("hex")
      .slice(0, 24);
  }

  correlations(principal: VerifiedManimPrincipal) {
    if (!isVerifiedManimPrincipal(principal)) throw new TypeError("A verified principal is required for telemetry.");
    return Object.freeze({
      principalCorrelation: this.#correlation("principal", principalScope(principal)),
      tenantCorrelation: this.#correlation("tenant", principal.tenantId),
    });
  }

  #states(principal: VerifiedManimPrincipal) {
    if (!isVerifiedManimPrincipal(principal)) throw new TypeError("A verified principal is required for admission.");
    const now = this.#now();
    if (!Number.isFinite(now)) throw new TypeError("The admission clock returned an invalid time.");
    this.#removeExpiredInactive(this.#principals, now);
    this.#removeExpiredInactive(this.#tenants, now);

    const principalKey = principalScope(principal);
    const principalState = this.#principals.get(principalKey);
    const tenantState = this.#tenants.get(principal.tenantId);
    if (principalState) this.#refresh(principalState, now);
    if (tenantState) this.#refresh(tenantState, now);

    return { now, principalKey, principalState, tenantState };
  }

  #trackStates(principal: VerifiedManimPrincipal, states: ScopeLookup) {
    const principalState = states.principalState ?? { active: 0, requests: 0, windowStartedAt: states.now };
    const tenantState = states.tenantState ?? { active: 0, requests: 0, windowStartedAt: states.now };
    this.#principals.set(states.principalKey, principalState);
    this.#tenants.set(principal.tenantId, tenantState);
    return { principalState, tenantState };
  }

  consumeRequest(principal: VerifiedManimPrincipal) {
    const states = this.#states(principal);
    if (
      (!states.principalState && this.#principals.size >= this.#limits.maxTrackedPrincipals) ||
      (!states.tenantState && this.#tenants.size >= this.#limits.maxTrackedTenants) ||
      (states.principalState?.requests ?? 0) >= this.#limits.maxRequestsPerPrincipalWindow ||
      (states.tenantState?.requests ?? 0) >= this.#limits.maxRequestsPerTenantWindow
    ) {
      return false;
    }

    const { principalState, tenantState } = this.#trackStates(principal, states);
    principalState.requests += 1;
    tenantState.requests += 1;
    return true;
  }

  reserveGeneration(principal: VerifiedManimPrincipal): EditSuggestionGenerationAdmissionResult {
    const states = this.#states(principal);
    if (
      (!states.principalState && this.#principals.size >= this.#limits.maxTrackedPrincipals) ||
      (!states.tenantState && this.#tenants.size >= this.#limits.maxTrackedTenants) ||
      (states.principalState?.active ?? 0) >= this.#limits.maxConcurrentPerPrincipal ||
      (states.tenantState?.active ?? 0) >= this.#limits.maxConcurrentPerTenant
    ) {
      return { accepted: false };
    }

    const { principalState, tenantState } = this.#trackStates(principal, states);
    principalState.active += 1;
    tenantState.active += 1;

    let released = false;
    return {
      accepted: true,
      reservation: Object.freeze({
        release: () => {
          if (released) return;
          released = true;
          principalState.active = Math.max(0, principalState.active - 1);
          tenantState.active = Math.max(0, tenantState.active - 1);
        },
      }),
    };
  }
}

export function createEditSuggestionAdmissionController(
  options: ConstructorParameters<typeof EditSuggestionAdmissionController>[0] = {},
) {
  return new EditSuggestionAdmissionController(options);
}
