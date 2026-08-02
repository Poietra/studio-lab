import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AccountSessionViewV1 } from "../accounts/account-session-contract";
import type { BillingStatusViewV1 } from "./billing-contract";
import {
  accountRoleCanManageBillingV1,
  BillingSettingsControl,
  BillingStatusDetailsV1,
  billingAvailableActionsV1,
  billingExternalNavigationAllowedV1,
  billingReturnKindV1,
} from "./billing-settings";

function status(
  configured: boolean,
  subscriptionStatus: NonNullable<BillingStatusViewV1["subscription"]>["status"] | null,
): BillingStatusViewV1 {
  return {
    configured,
    entitlement: null,
    subscription:
      subscriptionStatus === null
        ? null
        : {
            cancelAtPeriodEnd: false,
            periodEnd: "2026-09-01T00:00:00.000Z",
            periodStart: "2026-08-01T00:00:00.000Z",
            planKey: "pro",
            status: subscriptionStatus,
          },
  };
}

describe("billing settings policy", () => {
  it("exposes billing settings only to owner and billing memberships", () => {
    expect(accountRoleCanManageBillingV1("owner")).toBe(true);
    expect(accountRoleCanManageBillingV1("billing")).toBe(true);
    expect(accountRoleCanManageBillingV1("admin")).toBe(false);
    expect(accountRoleCanManageBillingV1("member")).toBe(false);
  });

  it("uses Checkout for terminal or missing subscriptions and Portal for bound customers", () => {
    expect(billingAvailableActionsV1(status(false, null))).toEqual(["checkout"]);
    expect(billingAvailableActionsV1(status(true, null))).toEqual(["portal", "checkout"]);
    expect(billingAvailableActionsV1(status(true, "canceled"))).toEqual(["portal", "checkout"]);
    expect(billingAvailableActionsV1(status(true, "incomplete_expired"))).toEqual(["portal", "checkout"]);
    for (const subscriptionStatus of ["active", "trialing", "incomplete", "past_due", "paused", "unpaid"] as const) {
      expect(billingAvailableActionsV1(status(true, subscriptionStatus))).toEqual(["portal"]);
    }
  });

  it("recognizes only one explicit billing return marker", () => {
    expect(billingReturnKindV1("?billing=success")).toBe("success");
    expect(billingReturnKindV1("?billing=cancelled&workspace=one")).toBe("cancelled");
    expect(billingReturnKindV1("?billing=portal-return")).toBe("portal-return");
    expect(billingReturnKindV1("?billing=success&billing=cancelled")).toBeNull();
    expect(billingReturnKindV1("?billing=unknown")).toBeNull();
  });

  it("awaits the Editor flush gate before allowing an external billing navigation", async () => {
    const allowed = vi.fn(async () => true);
    const blocked = vi.fn(async () => false);

    await expect(billingExternalNavigationAllowedV1()).resolves.toBe(true);
    await expect(billingExternalNavigationAllowedV1(allowed)).resolves.toBe(true);
    await expect(billingExternalNavigationAllowedV1(blocked)).resolves.toBe(false);
    expect(allowed).toHaveBeenCalledOnce();
    expect(blocked).toHaveBeenCalledOnce();
  });

  it("renders a compact native dialog control without commercial claims", () => {
    const organization: AccountSessionViewV1["activeOrganization"] = {
      displayName: "Poietra",
      id: "organization-a",
      role: "owner",
    };
    const markup = renderToStaticMarkup(<BillingSettingsControl organization={organization} />);

    expect(markup).toContain(">Billing</button>");
    expect(markup).toContain("<dialog");
    expect(markup).toContain("Billing settings");
    expect(markup).not.toMatch(/price|currency|remaining/i);
  });

  it("disables the billing entry point while the Editor session transition is pending", () => {
    const organization: AccountSessionViewV1["activeOrganization"] = {
      displayName: "Poietra",
      id: "organization-a",
      role: "owner",
    };
    const markup = renderToStaticMarkup(<BillingSettingsControl disabled organization={organization} />);

    expect(markup).toContain('disabled=""');
    expect(markup).toContain(">Billing</button>");
  });

  it("shows only authoritative status, period, and render limit details", () => {
    const view: BillingStatusViewV1 = {
      configured: true,
      entitlement: {
        accessState: "active",
        accessUntil: "2026-09-01T00:00:00.000Z",
        periodEnd: "2026-09-01T00:00:00.000Z",
        periodStart: "2026-08-01T00:00:00.000Z",
        planKey: "pro",
        renderEnabled: true,
        renderJobLimit: 1_000,
        sourceGeneration: "3",
      },
      subscription: {
        cancelAtPeriodEnd: false,
        periodEnd: "2026-09-01T00:00:00.000Z",
        periodStart: "2026-08-01T00:00:00.000Z",
        planKey: "pro",
        status: "active",
      },
    };
    const markup = renderToStaticMarkup(<BillingStatusDetailsV1 status={view} />);

    expect(markup).toContain("Active");
    expect(markup).toContain("Aug 1, 2026");
    expect(markup).toContain("Sep 1, 2026");
    expect(markup).toContain("1,000 jobs per billing period");
    expect(markup).not.toMatch(/price|currency|remaining/i);
  });
});
