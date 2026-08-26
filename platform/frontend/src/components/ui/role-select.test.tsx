import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RoleSelect } from "@/components/ui/role-select";
import { useAllPermissions } from "@/lib/auth/auth.query";
import { useRoles } from "@/lib/role.query";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/role.query", () => ({ useRoles: vi.fn() }));

const PREDEFINED = ["admin", "platform_admin", "editor", "member"];

/** More roles than any single fetched page used to carry. */
function manyRoles() {
  return [
    ...PREDEFINED.map((role) => ({
      id: `id-${role}`,
      role,
      name: role,
      predefined: true,
      permission: { agent: ["read"] },
    })),
    ...Array.from({ length: 30 }, (_, i) => {
      const role = `squad_${String(i).padStart(2, "0")}`;
      return {
        id: `id-${role}`,
        role,
        name: role,
        predefined: false,
        permission: { agent: ["read"] },
      };
    }),
  ];
}

function mockRoles(roles: ReturnType<typeof manyRoles>) {
  vi.mocked(useRoles).mockReturnValue({
    data: roles,
    isPending: false,
  } as unknown as ReturnType<typeof useRoles>);
}

describe("RoleSelect", () => {
  beforeEach(() => {
    vi.mocked(useAllPermissions).mockReturnValue({
      data: { agent: ["read"] },
    } as unknown as ReturnType<typeof useAllPermissions>);
    mockRoles(manyRoles());
  });

  it("finds a role far down the list by searching for it", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();

    render(<RoleSelect value="member" onValueChange={onValueChange} />);

    await user.click(screen.getByRole("combobox"));
    await user.type(screen.getByPlaceholderText("Search roles..."), "squad 29");

    const match = screen.getByRole("button", { name: /Squad 29/i });
    await user.click(match);

    expect(onValueChange).toHaveBeenCalledWith("squad_29");
  });

  it("finds a role by the identifier the API uses", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();

    render(<RoleSelect value="member" onValueChange={onValueChange} />);

    await user.click(screen.getByRole("combobox"));
    await user.type(screen.getByPlaceholderText("Search roles..."), "squad_17");

    await user.click(screen.getByRole("button", { name: /Squad 17/i }));

    expect(onValueChange).toHaveBeenCalledWith("squad_17");
  });

  it("refuses roles granting permissions the viewer does not hold", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();

    const roles = manyRoles();
    roles[4] = {
      ...roles[4],
      permission: { agent: ["read", "delete"] },
    } as (typeof roles)[number];
    mockRoles(roles);

    render(<RoleSelect value="member" onValueChange={onValueChange} />);

    await user.click(screen.getByRole("combobox"));

    const escalating = screen.getByRole("button", { name: /Squad 00/i });
    expect(escalating).toBeDisabled();

    await user.click(escalating);
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("still offers every role when the picker configures a mapping", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();

    const roles = manyRoles();
    roles[4] = {
      ...roles[4],
      permission: { agent: ["read", "delete"] },
    } as (typeof roles)[number];
    mockRoles(roles);

    render(
      <RoleSelect
        value="member"
        onValueChange={onValueChange}
        restrictToGrantable={false}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("button", { name: /Squad 00/i }));

    expect(onValueChange).toHaveBeenCalledWith("squad_00");
  });
});
