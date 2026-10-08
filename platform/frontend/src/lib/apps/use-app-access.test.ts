import type { ScopedPermission } from "@archestra/shared";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useScopedCapabilities } from "@/lib/auth/auth.query";
import {
  type AppAccessContext,
  appActionDisabledReason,
  computeAppAccess,
  useAppAccessContext,
} from "./use-app-access";

vi.mock("@/lib/auth/auth.query");

const grant = (
  action: ScopedPermission["action"],
  scope: string,
): ScopedPermission => ({ resource: "app", action, scope }) as ScopedPermission;

const context = (scopedGrants: ScopedPermission[]): AppAccessContext => ({
  scopedGrants,
  isPending: false,
});

describe("computeAppAccess", () => {
  it("grants nothing without a scoped grant on the app", () => {
    const access = computeAppAccess({ id: "app-1" }, context([]));

    expect(access.canEdit).toBe(false);
    expect(access.canDeleteApp).toBe(false);
  });

  it("allows only the actions granted on that specific app", () => {
    const grants = context([grant("update", "app-1")]);

    expect(computeAppAccess({ id: "app-1" }, grants)).toMatchObject({
      canEdit: true,
      canDeleteApp: false,
    });
    expect(computeAppAccess({ id: "app-2" }, grants).canEdit).toBe(false);
  });

  it("applies a wildcard grant to every app", () => {
    const access = computeAppAccess(
      { id: "app-9" },
      context([grant("update", "*"), grant("delete", "*")]),
    );

    expect(access.canEdit).toBe(true);
    expect(access.canDeleteApp).toBe(true);
  });

  it("ignores grants on other resources", () => {
    const access = computeAppAccess(
      { id: "app-1" },
      context([
        { resource: "agent", action: "update", scope: "app-1" },
      ] as ScopedPermission[]),
    );

    expect(access.canEdit).toBe(false);
  });
});

describe("appActionDisabledReason", () => {
  const orgApp = { id: "app-1", scope: "org" as const };

  it("names the scope rule when the caller holds no grant on the app", () => {
    const access = computeAppAccess(orgApp, context([]));

    expect(
      appActionDisabledReason({ app: orgApp, access, action: "update" }),
    ).toBe("Only an admin can change this org-wide app");
  });

  it("returns no reason when the action is granted", () => {
    const access = computeAppAccess(
      orgApp,
      context([grant("delete", "app-1")]),
    );

    expect(
      appActionDisabledReason({ app: orgApp, access, action: "delete" }),
    ).toBeUndefined();
    expect(
      appActionDisabledReason({ app: orgApp, access, action: "update" }),
    ).toBeDefined();
  });

  it("reports a pending check while grants load", () => {
    const access = computeAppAccess(orgApp, {
      scopedGrants: [],
      isPending: true,
    });

    expect(
      appActionDisabledReason({ app: orgApp, access, action: "update" }),
    ).toBe("Checking permissions…");
  });
});

describe("useAppAccessContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps collection access facts stable when their query data has not changed", () => {
    const grants = [grant("update", "app-1")];
    vi.mocked(useScopedCapabilities).mockReturnValue({
      data: grants,
      isPending: false,
    } as unknown as ReturnType<typeof useScopedCapabilities>);
    const { result, rerender } = renderHook(() => useAppAccessContext());
    const initialContext = result.current;

    rerender();

    expect(result.current).toBe(initialContext);
    expect(result.current.scopedGrants).toBe(grants);
  });
});
