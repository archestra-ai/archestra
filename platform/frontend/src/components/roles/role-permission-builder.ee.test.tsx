import type { Permissions } from "@archestra/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
} as typeof ResizeObserver;

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

import { RolePermissionBuilder } from "./role-permission-builder.ee";

describe("RolePermissionBuilder", () => {
  it("shows indeterminate state for preloaded partial permissions", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const permission: Permissions = {
      knowledgeSource: ["query"],
    };
    const userPermissions: Permissions = {
      knowledgeSource: ["read", "create", "update", "delete", "query"],
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
      screen.getByRole("checkbox", { name: "Knowledge Sources permissions" }),
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

  it("shows ungrantable permissions as disabled with an explanation", async () => {
    const user = userEvent.setup();

    render(
      <RolePermissionBuilder
        permission={{}}
        onChange={vi.fn()}
        userPermissions={{
          knowledgeSource: ["read"],
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Knowledge" }));

    const createCheckbox = document.getElementById("knowledgeSource-create");
    expect(createCheckbox).toBeDisabled();

    expect(
      screen.getAllByText(
        "You can only grant permissions that you currently have yourself.",
      ).length,
    ).toBeGreaterThan(0);
  });
});

it("filters resources without losing selections and supports reviewing selected permissions", async () => {
  function Editor() {
    const [permission, setPermission] = useState<Permissions>({
      knowledgeSource: ["query"],
    });
    return (
      <RolePermissionBuilder
        permission={permission}
        onChange={setPermission}
        userPermissions={{
          knowledgeSource: ["read", "query"],
          knowledgeSettings: ["read"],
        }}
      />
    );
  }
  const user = userEvent.setup();
  render(<Editor />);
  await user.type(
    screen.getByRole("textbox", { name: "Search permissions" }),
    "knowledge sources",
  );
  expect(screen.getByLabelText("Query")).toBeChecked();
  expect(
    screen.queryByRole("checkbox", { name: "Knowledge Settings permissions" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByLabelText("Read"));
  await user.clear(screen.getByRole("textbox", { name: "Search permissions" }));
  await user.click(screen.getByRole("button", { name: "Selected only" }));
  expect(screen.getByLabelText("Read")).toBeChecked();
  expect(screen.getByLabelText("Query")).toBeChecked();
  await user.click(screen.getByRole("button", { name: "Clear All" }));
  expect(
    screen.getByText("No selected permissions match your search."),
  ).toBeVisible();
});
