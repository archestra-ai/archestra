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

    const { container, rerender } = render(
      <RolePermissionBuilder
        permission={permission}
        onChange={onChange}
        userPermissions={userPermissions}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Knowledge" }));

    expect(container.querySelector("#category-Knowledge")).toHaveAttribute(
      "data-state",
      "indeterminate",
    );
    expect(container.querySelector("#knowledgeBase-all")).toHaveAttribute(
      "data-state",
      "indeterminate",
    );
    expect(container.querySelector("#knowledgeBase-query")).toHaveAttribute(
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

    expect(container.querySelector("#knowledgeBase-query")).toHaveAttribute(
      "data-state",
      "unchecked",
    );
    expect(container.querySelector("#knowledgeSettings-all")).toHaveAttribute(
      "data-state",
      "indeterminate",
    );
  });
});
