import type { Permissions } from "@archestra/shared";
import { predefinedPermissionsMap } from "@archestra/shared/access-control";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PermissionList } from "./permission-list.ee";

const everything: Permissions = predefinedPermissionsMap.admin;

function resource(label: string) {
  return screen.getByRole("region", { name: label });
}

describe("PermissionList", () => {
  it("grants and revokes one permission at a time", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <PermissionList
        permissions={{}}
        onChange={onChange}
        grantable={everything}
      />,
    );
    fireEvent.click(
      within(resource("Agents")).getByRole("checkbox", { name: "View agents" }),
    );
    expect(onChange).toHaveBeenLastCalledWith({ agent: ["read"] });

    rerender(
      <PermissionList
        permissions={{ agent: ["read", "create"] }}
        onChange={onChange}
        grantable={everything}
      />,
    );
    fireEvent.click(
      within(resource("Agents")).getByRole("checkbox", { name: "View agents" }),
    );
    expect(onChange).toHaveBeenLastCalledWith({ agent: ["create"] });
  });

  it("a resource's select-all adds only what the author can grant, and keeps the rest", () => {
    const onChange = vi.fn();
    render(
      <PermissionList
        permissions={{ agent: ["delete"], skill: ["read"] }}
        onChange={onChange}
        grantable={{ agent: ["read", "create"] }}
      />,
    );
    const all = within(resource("Agents")).getByRole("checkbox", {
      name: "Agents: all",
    });
    fireEvent.click(all);
    // `delete` was granted by someone who could; it is not this author's to
    // touch either way.
    expect(onChange).toHaveBeenLastCalledWith({
      agent: ["delete", "read", "create"],
      skill: ["read"],
    });
    // A resource the author holds nothing of cannot be selected at all.
    expect(
      within(resource("Skills")).getByRole("checkbox", { name: "Skills: all" }),
    ).toBeDisabled();
  });

  it("lets an author revoke, but not add, a permission they do not hold", () => {
    render(
      <PermissionList
        permissions={{ agent: ["read"] }}
        onChange={vi.fn()}
        grantable={{}}
      />,
    );
    const agents = resource("Agents");
    expect(
      within(agents).getByRole("checkbox", { name: "View agents" }),
    ).toBeEnabled();
    expect(
      within(agents).getByRole("checkbox", { name: "Create agents" }),
    ).toBeDisabled();
  });

  it("search keeps only the matching rows and drops empty resources", () => {
    render(
      <PermissionList
        permissions={{}}
        onChange={vi.fn()}
        grantable={everything}
      />,
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Search permissions" }),
      {
        target: { value: "impersonate" },
      },
    );
    expect(screen.queryByRole("region", { name: "Agents" })).toBeNull();
    const row = screen.getByRole("checkbox", { name: /^Impersonate / });
    const members = row.closest("section") as HTMLElement;
    expect(row).toBeVisible();
    expect(within(members).getAllByRole("checkbox")).toHaveLength(2);
    expect(
      within(members).queryByRole("checkbox", { name: /^View / }),
    ).toBeNull();
  });

  it("an area chip hides every other area and its heading", () => {
    render(
      <PermissionList
        permissions={{}}
        onChange={vi.fn()}
        grantable={everything}
      />,
    );
    expect(screen.getByRole("heading", { name: "Agents" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "MCP" }));
    expect(screen.queryByRole("region", { name: "Agents" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Agents" })).toBeNull();
    expect(resource("MCP Gateways")).toBeVisible();
  });

  it("read-only opens on the granted rows, and All shows what is missing", () => {
    render(<PermissionList permissions={{ agent: ["read"] }} />);
    expect(screen.queryByRole("checkbox")).toBeNull();
    const agents = resource("Agents");
    expect(within(agents).getByText("View agents")).toBeVisible();
    expect(within(agents).queryByText("Create agents")).toBeNull();
    expect(screen.queryByRole("region", { name: "Skills" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(within(resource("Agents")).getByText("Create agents")).toBeVisible();
    expect(resource("Skills")).toBeVisible();
  });

  it("says when a role grants nothing", () => {
    render(<PermissionList permissions={{}} />);
    expect(screen.getByText("This role grants no permissions.")).toBeVisible();
  });
});
