// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RolePicker } from "@/components/ui/role-picker";
import { useAllPermissions } from "@/lib/auth/auth.query";
import { useRoles } from "@/lib/role.query";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/role.query", () => ({ useRoles: vi.fn() }));

function Harness({
  initial = "member",
  onChange,
}: {
  initial?: string;
  onChange?: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <RolePicker
        value={value}
        onValueChange={(next) => {
          setValue(next);
          onChange?.(next);
        }}
      />
      <output data-testid="value">{value}</output>
    </>
  );
}

/** Open the picker and show one area's roles in the right pane. */
async function openArea(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) {
  await user.click(screen.getByRole("combobox", { name: "Roles" }));
  await user.click(
    screen.getByRole("button", { name: new RegExp(`^${name}`) }),
  );
}

describe("RolePicker", () => {
  beforeEach(() => {
    vi.mocked(useRoles).mockReturnValue({
      data: [
        {
          id: "admin",
          role: "admin",
          name: "Admin",
          predefined: true,
          permission: {
            agent: ["read", "create", "delete"],
            log: ["read", "admin"],
          },
        },
        {
          id: "member",
          role: "member",
          name: "Member",
          predefined: true,
          permission: { agent: ["read"] },
        },
      ],
      isPending: false,
    } as unknown as ReturnType<typeof useRoles>);
    vi.mocked(useAllPermissions).mockReturnValue({
      data: {
        agent: ["read", "create", "delete"],
        log: ["read"],
        guardrailsYell: ["read"],
        mcpGateway: ["read", "create", "delete"],
      },
    } as unknown as ReturnType<typeof useAllPermissions>);
  });

  it("applies each choice at once and shows it on the trigger", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await openArea(user, "Agents");
    await user.click(screen.getByRole("checkbox", { name: /^Agent Writer/ }));
    expect(screen.getByTestId("value")).toHaveTextContent(
      "member,fixed:agents:writer",
    );
    expect(
      screen.getByRole("button", { name: "Remove Agent Writer" }),
    ).toBeVisible();
  });

  it("keeps the last required role", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("combobox", { name: "Roles" }));
    await user.click(screen.getByRole("checkbox", { name: /^Member/ }));
    expect(screen.getByTestId("value")).toHaveTextContent("member");
  });

  it("takes a whole area with its checkbox, skipping roles the viewer cannot grant", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("combobox", { name: "Roles" }));
    // The viewer holds the reader permissions but not log:admin, so Log Admin
    // stays out.
    await user.click(
      screen.getByRole("checkbox", { name: "Select all Logs & Audit roles" }),
    );
    const value = screen.getByTestId("value");
    expect(value).toHaveTextContent("fixed:logs:reader");
    expect(value).not.toHaveTextContent("fixed:logs:admin");
  });

  it("refuses a role granting what the viewer lacks and says why", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await openArea(user, "Logs & Audit");
    const locked = screen.getByRole("checkbox", { name: /^Log Admin/ });
    expect(locked).toHaveAttribute("aria-disabled", "true");
    await user.click(locked);
    expect(screen.getByTestId("value")).toHaveTextContent(/^member$/);

    await user.click(
      screen.getByRole("button", { name: "Show what Log Admin grants" }),
    );
    expect(screen.getByText(/You can't grant this/)).toBeVisible();
  });

  it("unfolds a role's permissions in words, never as raw keys", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await openArea(user, "Agents");
    await user.click(
      screen.getByRole("button", { name: "Show what Agent Writer grants" }),
    );
    const granted = screen.getByRole("list", { name: "3 permissions" });
    expect(within(granted).getByText("View agents")).toBeVisible();
    expect(within(granted).getByText("Create agents")).toBeVisible();
    expect(granted).not.toHaveTextContent(":");
    // Nothing floats over the menu.
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("leaves out a stored permission that no longer exists", async () => {
    vi.mocked(useRoles).mockReturnValue({
      data: [
        {
          id: "member",
          role: "member",
          name: "Member",
          predefined: true,
          permission: { agent: ["read"] },
        },
        {
          id: "legacy",
          role: "legacy",
          name: "Legacy",
          predefined: false,
          permission: { agent: ["read", "configure-runtime"] },
        },
      ],
      isPending: false,
    } as unknown as ReturnType<typeof useRoles>);
    const user = userEvent.setup();
    render(<Harness />);

    await openArea(user, "Custom roles");
    await user.click(
      screen.getByRole("button", { name: "Show what Legacy grants" }),
    );
    const granted = screen.getByRole("list", { name: "1 permission" });
    expect(granted).toHaveTextContent("View agents");
    expect(granted).not.toHaveTextContent("configure-runtime");
  });

  it("finds a granular role by searching across areas", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("combobox", { name: "Roles" }));
    await user.type(
      screen.getByRole("textbox", { name: "Search roles" }),
      "gateway writer",
    );
    await user.click(
      screen.getByRole("checkbox", { name: /^MCP Gateway Writer/ }),
    );
    expect(screen.getByTestId("value")).toHaveTextContent(
      "member,fixed:mcp-gateways:writer",
    );
  });
});
