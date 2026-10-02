import type { Permissions } from "@archestra/shared";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { RolePermissionBuilder } from "./role-permission-builder.ee";

describe("RolePermissionBuilder", () => {
  it("keeps partial selections and reflects changes to the role being edited", async () => {
    const props = {
      onChange: vi.fn(),
      userPermissions: {
        knowledgeSource: ["read", "create", "update", "delete", "query"],
        knowledgeSettings: ["read", "update"],
      } as Permissions,
    };
    const { rerender } = render(
      <RolePermissionBuilder
        {...props}
        permission={{ knowledgeSource: ["query"] }}
      />,
    );
    expect(
      screen.getByRole("checkbox", {
        name: "Select all Knowledge permissions",
      }),
    ).toHaveAttribute("data-state", "indeterminate");
    expect(
      screen.getByRole("checkbox", {
        name: "Knowledge Sources permissions",
      }),
    ).toHaveAttribute("data-state", "indeterminate");
    expect(
      screen.getByRole("checkbox", {
        name: "Knowledge Sources Query",
      }),
    ).toBeChecked();
    rerender(
      <RolePermissionBuilder
        {...props}
        permission={{ knowledgeSettings: ["read"] }}
      />,
    );
    expect(
      screen.getByRole("checkbox", {
        name: "Knowledge Sources Query",
      }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("checkbox", {
        name: "Knowledge Settings permissions",
      }),
    ).toHaveAttribute("data-state", "indeterminate");
  });

  it("disables ungrantable actions and explains why", async () => {
    const user = userEvent.setup();
    render(
      <RolePermissionBuilder
        permission={{}}
        onChange={vi.fn()}
        userPermissions={{ knowledgeSource: ["read"] }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Knowledge" }));
    const checkbox = screen.getByRole("checkbox", {
      name: "Knowledge Sources Create",
    });
    expect(checkbox).toBeDisabled();
    const label = checkbox.closest("label");
    if (!label) throw new Error("Permission control has no label");
    await user.hover(label);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "You can only grant permissions that you currently have yourself.",
    );
  });

  it("preserves selections when switching categories", async () => {
    const user = userEvent.setup();
    render(
      <Editor
        initial={{ knowledgeSource: ["query"] }}
        grantable={{
          knowledgeSource: ["read", "query"],
          agent: ["read"],
        }}
      />,
    );
    await user.click(
      screen.getByRole("checkbox", { name: "Knowledge Sources Read" }),
    );
    await user.click(screen.getByRole("button", { name: "Agents" }));
    await user.click(screen.getByRole("checkbox", { name: "Agents Read" }));
    await user.click(screen.getByRole("button", { name: "Knowledge" }));
    expect(
      screen.getByRole("checkbox", { name: "Knowledge Sources Read" }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "Knowledge Sources Query" }),
    ).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Agents" }));
    expect(screen.getByRole("checkbox", { name: "Agents Read" })).toBeChecked();
  });

  it("bulk selection adds only grantable actions and retains existing stronger grants", async () => {
    const user = userEvent.setup();
    render(
      <Editor
        initial={{ agent: ["delete"] }}
        grantable={{ agent: ["read"], skill: ["read"] }}
      />,
    );
    await user.click(
      screen.getByRole("checkbox", { name: "Agents permissions" }),
    );
    expect(screen.getByRole("checkbox", { name: "Agents Read" })).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "Agents Delete" }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "Agents Update" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("checkbox", { name: "Skills Read" }),
    ).not.toBeChecked();
    await user.click(
      within(
        screen.getByRole("region", { name: "Agents resources" }),
      ).getByRole("checkbox", {
        name: "Select all Agents permissions",
      }),
    );
    expect(screen.getByRole("checkbox", { name: "Skills Read" })).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "Agents Delete" }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "Skills Create" }),
    ).not.toBeChecked();
  });

  it("shows granted permissions as a readable view without editing controls", () => {
    render(
      <RolePermissionBuilder
        permission={{ agent: ["read", "create"] }}
        userPermissions={{}}
        onChange={vi.fn()}
        readOnly
      />,
    );
    expect(
      screen.getByRole("button", { name: "Agents Read granted" }),
    ).toBeVisible();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Clear" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: "Skills actions" }),
    ).not.toBeInTheDocument();
  });
});

function Editor({
  initial,
  grantable,
}: {
  initial: Permissions;
  grantable: Permissions;
}) {
  const [permission, setPermission] = useState(initial);
  return (
    <RolePermissionBuilder
      permission={permission}
      onChange={setPermission}
      userPermissions={grantable}
    />
  );
}
