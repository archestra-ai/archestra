import type { Permissions } from "@shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RolePermissionBuilder } from "./role-permission-builder.ee";

describe("RolePermissionBuilder", () => {
  it("shows indeterminate state for preloaded partial permissions", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const permission: Permissions = {
      knowledgeBase: ["query"],
    };
    const userPermissions: Permissions = {
      knowledgeBase: ["read", "create", "update", "delete", "query"],
      knowledgeSettings: ["read", "update"],
    };

    const { rerender } = render(
      <RolePermissionBuilder
        permission={permission}
        onChange={onChange}
        userPermissions={userPermissions}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Knowledge" }));

    expect(
      screen.getByRole("checkbox", { name: "Knowledge permissions" }),
    ).toHaveAttribute("data-state", "indeterminate");
    expect(
      screen.getByRole("checkbox", { name: "Knowledge Bases permissions" }),
    ).toHaveAttribute("data-state", "indeterminate");
    expect(screen.getByLabelText("Query")).toHaveAttribute(
      "data-state",
      "checked",
    );

    rerender(
      <RolePermissionBuilder
        permission={{ knowledgeSettings: ["read"] }}
        onChange={onChange}
        userPermissions={userPermissions}
      />,
    );

    expect(screen.getByLabelText("Query")).toHaveAttribute(
      "data-state",
      "unchecked",
    );
    expect(
      screen.getByRole("checkbox", {
        name: "Knowledge Settings permissions",
      }),
    ).toHaveAttribute("data-state", "indeterminate");
  });
});
