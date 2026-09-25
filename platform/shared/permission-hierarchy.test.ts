import { describe, expect, it } from "vitest";
import { isPermissionActionGranted } from "./permission-hierarchy";

describe("isPermissionActionGranted", () => {
  it("grants exactly the actions a role holds, with no implied actions", () => {
    const grantedActions = ["read", "create", "update", "delete"] as const;
    for (const requiredAction of grantedActions) {
      expect(
        isPermissionActionGranted({
          resource: "mcpServerInstallation",
          grantedActions: [...grantedActions],
          requiredAction,
        }),
      ).toBe(true);
    }
    expect(
      isPermissionActionGranted({
        resource: "mcpServerInstallation",
        grantedActions: [...grantedActions],
        requiredAction: "manage-deleted",
      }),
    ).toBe(false);
  });
});
