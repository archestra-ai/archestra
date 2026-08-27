import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RoleFilterSelect } from "@/components/role-filter-select";
import { useRoles } from "@/lib/role.query";

vi.mock("@/lib/role.query", () => ({ useRoles: vi.fn() }));

const ROLES = [
  { id: "id-admin", role: "admin", name: "admin", predefined: true },
  { id: "id-member", role: "member", name: "member", predefined: true },
  {
    id: "id-audit",
    role: "night_auditor",
    name: "Ledger Watch",
    predefined: false,
  },
];

describe("RoleFilterSelect", () => {
  beforeEach(() => {
    vi.mocked(useRoles).mockReturnValue({
      data: ROLES,
      isPending: false,
    } as unknown as ReturnType<typeof useRoles>);
  });

  it("keeps the clear-the-filter option reachable while searching", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();

    render(<RoleFilterSelect value="admin" onValueChange={onValueChange} />);

    await user.click(screen.getByRole("combobox"));
    await user.type(screen.getByPlaceholderText("Search roles..."), "ledger");

    // The search narrowed the roles, but the way back out of it survives.
    expect(screen.queryByRole("button", { name: /^Admin$/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "All roles" }));

    expect(onValueChange).toHaveBeenCalledWith("all");
  });

  it("finds a role by the identifier the API speaks in", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();

    render(<RoleFilterSelect value="all" onValueChange={onValueChange} />);

    await user.click(screen.getByRole("combobox"));
    // The display name is "Ledger Watch"; `night_auditor` is what a service
    // account's role reads as over the API.
    await user.type(
      screen.getByPlaceholderText("Search roles..."),
      "night_auditor",
    );
    await user.click(screen.getByRole("button", { name: "Ledger Watch" }));

    expect(onValueChange).toHaveBeenCalledWith("night_auditor");
  });
});
