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

async function openGroup(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) {
  await user.click(screen.getByRole("combobox", { name: "Roles" }));
  const groups = screen.getByRole("navigation", { name: "Role groups" });
  await user.click(
    within(groups).getByRole("button", { name: new RegExp(`^${name}`) }),
  );
  return screen.getByRole("list", { name: `${name} roles` });
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
        mcpGateway: ["read", "create", "delete"],
      },
    } as unknown as ReturnType<typeof useAllPermissions>);
  });

  it("stages choices until Update and discards them when closed", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    const agents = await openGroup(user, "Agents");
    await user.click(within(agents).getByLabelText("Agent Writer"));
    await user.keyboard("{Escape}");
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("value")).toHaveTextContent("member");

    const again = await openGroup(user, "Agents");
    await user.click(within(again).getByLabelText("Agent Writer"));
    await user.click(screen.getByRole("button", { name: "Update" }));
    expect(screen.getByTestId("value")).toHaveTextContent(
      "member,fixed:agents:writer",
    );
    expect(
      screen.getByRole("button", { name: "Remove Agent Writer" }),
    ).toBeVisible();
  });

  it("takes a whole group with its checkbox, skipping roles the viewer cannot grant", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await openGroup(user, "Agents");
    // The viewer lacks agent:configure-runtime, so the runtime role stays out.
    await user.click(
      screen.getByRole("checkbox", { name: "Select all Agents roles" }),
    );
    await user.click(screen.getByRole("button", { name: "Update" }));
    expect(screen.getByTestId("value")).toHaveTextContent(
      "member,fixed:agents:reader,fixed:agents:writer",
    );
  });

  it("refuses a role granting what the viewer lacks", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const logs = await openGroup(user, "Logs & Audit");
    expect(
      within(logs).getByRole("checkbox", { name: "Log Admin" }),
    ).toBeDisabled();
    expect(
      within(logs).getByRole("checkbox", { name: "Log Reader" }),
    ).toBeEnabled();
  });

  it("clears one group with Clear and everything with Clear all", async () => {
    const user = userEvent.setup();
    render(
      <Harness initial="member,fixed:agents:reader,fixed:mcp-gateways:reader" />,
    );

    await openGroup(user, "Agents");
    await user.click(screen.getByRole("button", { name: "Clear" }));
    await user.click(screen.getByRole("button", { name: "Update" }));
    expect(screen.getByTestId("value")).toHaveTextContent(
      "member,fixed:mcp-gateways:reader",
    );

    await user.click(screen.getByRole("combobox", { name: "Roles" }));
    await user.click(screen.getByRole("button", { name: "Clear all" }));
    // An assignment needs at least one role.
    expect(screen.getByRole("button", { name: "Update" })).toBeDisabled();
  });

  it("finds a fixed role by searching across groups", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("combobox", { name: "Roles" }));
    await user.type(
      screen.getByRole("textbox", { name: "Search roles" }),
      "gateway writer",
    );
    const results = screen.getByRole("list", { name: "Matching roles" });
    await user.click(
      within(results).getByRole("checkbox", { name: /^MCP Gateway Writer/ }),
    );
    await user.click(screen.getByRole("button", { name: "Update" }));
    expect(screen.getByTestId("value")).toHaveTextContent(
      "member,fixed:mcp-gateways:writer",
    );
  });
});
