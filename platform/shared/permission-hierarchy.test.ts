import { describe, expect, it } from "vitest";
import { isPermissionActionGranted } from "./permission-hierarchy";

describe("isPermissionActionGranted", () => {
  it("lets installation admin satisfy CRUD but not deleted-resource lifecycle", () => {
    for (const requiredAction of [
      "read",
      "create",
      "update",
      "delete",
    ] as const) {
      expect(
        isPermissionActionGranted({
          resource: "mcpServerInstallation",
          grantedActions: ["admin"],
          requiredAction,
        }),
      ).toBe(true);
    }
    expect(
      isPermissionActionGranted({
        resource: "mcpServerInstallation",
        grantedActions: ["admin"],
        requiredAction: "manage-deleted",
      }),
    ).toBe(false);
  });
});
