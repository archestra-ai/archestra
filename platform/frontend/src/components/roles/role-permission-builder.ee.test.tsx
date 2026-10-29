import type { Permissions } from "@archestra/shared";
import { render, screen } from "@testing-library/react";
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
        permission={{ knowledgeSource: ["read"] }}
      />,
    );
    expect(
      screen.getByRole("checkbox", {
        name: "Knowledge Sources Query",
      }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("checkbox", {
        name: "Knowledge Sources Read",
      }),
    ).toBeChecked();
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
    await user.click(screen.getByRole("button", { name: "Other" }));
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
    await user.click(screen.getByRole("button", { name: "Other" }));
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
      screen.getByRole("checkbox", { name: "Agents Create" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("checkbox", { name: "Skills Read" }),
    ).not.toBeChecked();
    await user.click(
      screen.getByRole("checkbox", { name: "Skills permissions" }),
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

it("distinguishes object-controlled actions from ungranted role actions", () => {
  render(
    <RolePermissionBuilder
      permission={{ app: ["read", "create"], plugin: ["read"] }}
      userPermissions={{}}
      onChange={vi.fn()}
      readOnly
    />,
  );
  expect(
    screen.getByLabelText("Apps Update: set in object permissions"),
  ).toHaveTextContent("Per object");
  expect(screen.getByText("Plugins Update not granted")).toBeInTheDocument();
  expect(
    screen.queryByRole("checkbox", { name: "Apps Update" }),
  ).not.toBeInTheDocument();
});

it("links each category to its corresponding all-item permissions without replacing the role editor", async () => {
  const user = userEvent.setup();
  render(
    <RolePermissionBuilder
      permission={{
        app: ["read"],
        oauthClient: ["read"],
      }}
      userPermissions={{}}
      onChange={vi.fn()}
      readOnly
    />,
  );
  const apps = screen.getByRole("link", {
    name: "Permissions for all Apps (opens in a new tab)",
  });
  expect(apps).toHaveAttribute("href", "/apps?permissions=all");
  expect(apps).toHaveAttribute("target", "_blank");
  await user.click(screen.getByRole("button", { name: "Administration" }));
  expect(
    screen.getByRole("link", {
      name: "Permissions for all OAuth Clients (opens in a new tab)",
    }),
  ).toHaveAttribute("href", "/settings/oauth-clients?permissions=all");
});

it("shows Manage access without adding an invalid action to the role", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(
    <RolePermissionBuilder
      permission={{ app: ["read"] }}
      userPermissions={{ app: ["read", "create"] }}
      onChange={onChange}
    />,
  );
  const manage = screen.getByRole("button", {
    name: "Apps Manage access: set in object permissions",
  });
  expect(manage).toHaveTextContent("Per object");
  await user.hover(manage);
  expect(await screen.findByRole("tooltip")).toHaveTextContent(
    "Change who can access the item and their permission levels.",
  );
  expect(
    screen.queryByRole("checkbox", { name: "Apps Manage access" }),
  ).not.toBeInTheDocument();
  expect(onChange).not.toHaveBeenCalled();
  await user.click(screen.getByRole("checkbox", { name: "Apps Create" }));
  expect(onChange).toHaveBeenLastCalledWith({ app: ["read", "create"] });
});

it("offers individual environment grants and knowledge permission shortcuts", async () => {
  const user = userEvent.setup();
  render(
    <RolePermissionBuilder
      permission={{
        environment: ["read"],
        knowledgeSource: ["read"],
      }}
      userPermissions={{}}
      onChange={vi.fn()}
      readOnly
    />,
  );
  await user.click(screen.getByRole("button", { name: "Administration" }));
  expect(
    screen.getByRole("button", {
      name: "Environments Manage access: set in object permissions",
    }),
  ).toHaveTextContent("Per object");
  await user.click(screen.getByRole("button", { name: "Other" }));
  expect(
    screen.getByRole("link", {
      name: "Permissions for all Knowledge Bases (opens in a new tab)",
    }),
  ).toHaveAttribute("href", "/knowledge/knowledge-bases?permissions=all");
  expect(
    screen.getByRole("link", {
      name: "Permissions for all Connectors (opens in a new tab)",
    }),
  ).toHaveAttribute("href", "/knowledge/connectors?permissions=all");
});
