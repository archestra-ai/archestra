import type { archestraApiTypes } from "@archestra/shared";
import { archestraApiSdk } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAllPermissions, useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useMemberSearch } from "@/lib/member.query";
import { useRoles } from "@/lib/role.query";
import { TeamManagementDialog } from "./team-management-dialog";

type Team = archestraApiTypes.GetTeamsResponses["200"]["data"][number];

const { useTeamsMock } = vi.hoisted(() => ({
  useTeamsMock: vi.fn(),
}));

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/role.query", () => ({ useRoles: vi.fn() }));
vi.mock("@/lib/config/config.query");
vi.mock("@/lib/member.query");
vi.mock("@/lib/config/config", () => ({
  default: { enterpriseFeatures: { core: false } },
}));
vi.mock("@/lib/teams/team.query", () => ({
  useTeams: useTeamsMock,
}));
vi.mock("@archestra/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@archestra/shared")>()),
  archestraApiSdk: {
    addTeamMember: vi.fn(),
    getTeamMembers: vi.fn(),
    getTeamMembersPage: vi.fn(),
    removeTeamMember: vi.fn(),
    updateTeamMember: vi.fn(),
    updateTeam: vi.fn(),
  },
}));

const team = {
  id: "team-1",
  name: "Platform Engineering",
  description: "",
  labels: [],
} as unknown as Team;

// The role trigger's accessible name does not include its rendered value
// (Radix SelectValue), so locate it by its visible content instead.
async function findRoleTrigger(label: RegExp) {
  return await waitFor(() => {
    const trigger = screen
      .getAllByRole("combobox")
      .find((el) => label.test(el.textContent ?? ""));
    if (!trigger) throw new Error(`No combobox showing ${label}`);
    return trigger;
  });
}

// The summary line ("45 members · 1 admin · …") spans several elements.
async function findSummary(text: RegExp) {
  return await screen.findByText(
    (_, element) =>
      element?.tagName === "P" &&
      text.test((element.textContent ?? "").replace(/\s*·\s*/g, " · ")),
  );
}

async function setupUserEvent() {
  // Radix Select relies on pointer-capture + scrollIntoView, which jsdom
  // does not implement.
  window.HTMLElement.prototype.hasPointerCapture = vi.fn();
  window.HTMLElement.prototype.setPointerCapture = vi.fn();
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  const { default: userEvent } = await import("@testing-library/user-event");
  return userEvent.setup();
}

function renderDialog() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <TeamManagementDialog open onOpenChange={vi.fn()} team={team} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useAllPermissions).mockReturnValue({ data: {} } as ReturnType<
    typeof useAllPermissions
  >);
  vi.mocked(useRoles).mockReturnValue({
    data: [],
    isPending: false,
  } as unknown as ReturnType<typeof useRoles>);
  vi.mocked(useFeature).mockReturnValue(false as ReturnType<typeof useFeature>);
  vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
    typeof useHasPermissions
  >);
  vi.mocked(useMemberSearch).mockReturnValue({
    users: [],
    isSearching: false,
    onSearchQueryChange: vi.fn(),
    emptyMessage: "",
    // biome-ignore lint/suspicious/noExplicitAny: partial hook result stub
  } as any);
  useTeamsMock.mockReturnValue({ data: [] });
  serveMembers([
    {
      userId: "u-1",
      role: "member",
      name: "Rosa Lindqvist",
      email: "rosa@example.com",
    },
  ]);
  vi.mocked(archestraApiSdk.updateTeam).mockResolvedValue({
    data: team,
    // biome-ignore lint/suspicious/noExplicitAny: partial sdk result stub
  } as any);
  vi.mocked(archestraApiSdk.updateTeamMember).mockResolvedValue({
    data: {},
    // biome-ignore lint/suspicious/noExplicitAny: partial sdk result stub
  } as any);
  vi.mocked(archestraApiSdk.addTeamMember).mockResolvedValue({
    data: {},
    // biome-ignore lint/suspicious/noExplicitAny: partial sdk result stub
  } as any);
  vi.mocked(archestraApiSdk.removeTeamMember).mockResolvedValue({
    data: {},
    // biome-ignore lint/suspicious/noExplicitAny: partial sdk result stub
  } as any);
});

type RosterMember = {
  userId: string;
  role: string;
  name: string;
  email: string;
};

// Serves the paged member endpoint from an in-memory roster the way the
// server does: optional name search, optional user-id filter, then a page.
// `holdSearch` delays answers to searches until it resolves.
function serveMembers(
  roster: RosterMember[],
  { holdSearch }: { holdSearch?: Promise<void> } = {},
) {
  vi.mocked(archestraApiSdk.getTeamMembersPage).mockImplementation((async ({
    query,
  }: {
    query?: {
      limit?: number;
      offset?: number;
      search?: string;
      userIds?: string[];
      role?: string;
    };
  }) => {
    if (query?.search && holdSearch) await holdSearch;
    const limit = query?.limit ?? 20;
    const offset = query?.offset ?? 0;
    const matches = roster.filter(
      (member) =>
        (!query?.search ||
          member.name.toLowerCase().includes(query.search.toLowerCase())) &&
        (!query?.userIds || query.userIds.includes(member.userId)) &&
        (!query?.role || member.role === query.role),
    );
    return {
      data: {
        data: matches.slice(offset, offset + limit),
        pagination: {
          currentPage: Math.floor(offset / limit) + 1,
          limit,
          total: matches.length,
          totalPages: Math.ceil(matches.length / limit),
          hasNext: offset + limit < matches.length,
          hasPrev: offset > 0,
        },
      },
    };
    // biome-ignore lint/suspicious/noExplicitAny: partial sdk result stub
  }) as any);
}

function largeRoster(size: number): RosterMember[] {
  return Array.from({ length: size }, (_, index) => {
    const n = String(index + 1).padStart(2, "0");
    return {
      userId: `u-${n}`,
      role: "member",
      name: `Member ${n}`,
      email: `member${n}@example.com`,
    };
  });
}

describe("TeamManagementDialog member roles", () => {
  it("keeps inherited roles visible and reveals parent and labels in Advanced", async () => {
    const user = await setupUserEvent();
    renderDialog();
    expect(
      screen.getByRole("combobox", { name: "Inherited Roles" }),
    ).toBeVisible();
    expect(screen.getByLabelText("Label key")).not.toBeVisible();
    expect(
      screen.queryByRole("combobox", { name: "Parent Team" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Advanced" }));
    expect(screen.getByLabelText("Label key")).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Parent Team" })).toBeVisible();
  });

  it("offers valid parent paths and excludes the current team's descendants", async () => {
    useTeamsMock.mockReturnValue({
      data: [
        { id: "root", name: "Product", parentId: null },
        { ...team, parentId: "root" },
        { id: "child", name: "Runtime", parentId: team.id },
        { id: "other", name: "Operations", parentId: null },
      ],
    });
    const user = await setupUserEvent();
    renderDialog();

    await user.click(screen.getByRole("button", { name: "Advanced" }));
    await user.click(screen.getByRole("combobox", { name: "Parent Team" }));

    const listbox = screen.getAllByRole("dialog").at(-1)!;
    expect(
      within(listbox).getByRole("option", { name: "Product" }),
    ).toBeInTheDocument();
    expect(
      within(listbox).getByRole("option", { name: "Operations" }),
    ).toBeInTheDocument();
    expect(
      within(listbox).queryByRole("option", { name: /Runtime/ }),
    ).not.toBeInTheDocument();
  });

  it("shows team Admin and Member roles with their responsibilities", async () => {
    const user = await setupUserEvent();
    renderDialog();
    await user.click(screen.getByRole("button", { name: "Members" }));

    const trigger = await findRoleTrigger(/^Member$/i);
    await user.click(trigger);

    const listbox = await screen.findByRole("listbox");
    expect(
      within(listbox).getByRole("option", { name: "Admin" }),
    ).toBeInTheDocument();
    expect(
      within(listbox).getByRole("option", { name: "Member" }),
    ).toBeInTheDocument();

    expect(
      within(listbox).getByText(/its members and LLM limits/),
    ).toBeInTheDocument();
  });

  it("still sends the stored role value when the new label is chosen", async () => {
    const user = await setupUserEvent();
    renderDialog();
    await user.click(screen.getByRole("button", { name: "Members" }));

    await user.click(await findRoleTrigger(/^Member$/i));
    await user.click(await screen.findByRole("option", { name: "Admin" }));
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(archestraApiSdk.updateTeamMember).toHaveBeenCalledWith({
        path: { id: "team-1", userId: "u-1" },
        body: { role: "admin" },
      });
    });
  });

  it("keeps unlicensed group sync disabled with its reason in the sidebar", async () => {
    const user = await setupUserEvent();
    renderDialog();
    const syncTab = screen.getByRole("button", { name: "Team Sync" });
    expect(syncTab).toBeDisabled();
    expect(syncTab).toHaveAccessibleDescription("Enterprise license required");
    await user.click(syncTab);
    expect(
      screen.getByRole("combobox", { name: "Inherited Roles" }),
    ).toBeVisible();
    expect(
      screen.queryByText(/Activate an Enterprise license/),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Members" }));
    expect(await findSummary(/^1 member · 0 admins$/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Synced groups/ }),
    ).not.toBeInTheDocument();
  });
});

describe("TeamManagementDialog members of a large team", () => {
  it("pages and searches members on the server instead of loading them all", async () => {
    serveMembers(largeRoster(45));
    const user = await setupUserEvent();
    renderDialog();
    await user.click(screen.getByRole("button", { name: "Members" }));

    expect(await findSummary(/^45 members · 0 admins$/)).toBeInTheDocument();
    expect(await screen.findByText("Member 20")).toBeInTheDocument();
    expect(screen.queryByText("Member 21")).not.toBeInTheDocument();

    await user.click(
      screen.getAllByRole("button", { name: "Go to next page" })[0],
    );
    expect(await screen.findByText("Member 21")).toBeInTheDocument();
    expect(screen.queryByText("Member 20")).not.toBeInTheDocument();

    await user.type(
      screen.getByRole("textbox", { name: "Search members" }),
      "member 4",
    );
    expect(await screen.findByText("Member 45")).toBeInTheDocument();
    expect(screen.queryByText("Member 21")).not.toBeInTheDocument();
    // The summary still describes the whole team, not the search.
    expect(await findSummary(/^45 members/)).toBeInTheDocument();
    expect(archestraApiSdk.getTeamMembers).not.toHaveBeenCalled();
  });

  it("dims the shown members while a search loads", async () => {
    let releaseSearch = () => {};
    serveMembers(largeRoster(45), {
      holdSearch: new Promise<void>((resolve) => {
        releaseSearch = resolve;
      }),
    });
    const user = await setupUserEvent();
    renderDialog();
    await user.click(screen.getByRole("button", { name: "Members" }));
    expect((await screen.findByText("Member 01")).closest(".opacity-60")).toBe(
      null,
    );

    await user.type(
      screen.getByRole("textbox", { name: "Search members" }),
      "member 4",
    );
    await waitFor(() =>
      expect(screen.getByText("Member 01").closest(".opacity-60")).not.toBe(
        null,
      ),
    );

    releaseSearch();
    const match = await screen.findByText("Member 45");
    expect(match.closest(".opacity-60")).toBe(null);
    expect(screen.queryByText("Member 01")).not.toBeInTheDocument();
  });

  it("keeps member changes staged on other pages and saves them all", async () => {
    serveMembers(largeRoster(45));
    const user = await setupUserEvent();
    renderDialog();
    await user.click(screen.getByRole("button", { name: "Members" }));
    await screen.findByText("Member 01");

    // Page 1: promote the first member.
    await user.click(await findRoleTrigger(/^Member$/i));
    await user.click(await screen.findByRole("option", { name: "Admin" }));
    // Page 2: remove its first member.
    await user.click(
      screen.getAllByRole("button", { name: "Go to next page" })[0],
    );
    await screen.findByText("Member 21");
    await user.click(
      screen.getByRole("button", { name: "Remove from team Member 21" }),
    );
    expect(screen.queryByText("Member 21")).not.toBeInTheDocument();
    expect(await findSummary(/^44 members · 1 admin/)).toBeInTheDocument();
    // The pager repeats it in its (CSS-hidden) mobile layout.
    expect(screen.getAllByText("2 unsaved changes")[0]).toBeInTheDocument();

    // Back on page 1 the promotion is still staged.
    await user.click(
      screen.getAllByRole("button", { name: "Go to previous page" })[0],
    );
    expect(await findRoleTrigger(/^Admin/i)).toBeInTheDocument();
    expect(screen.getByText("Changed")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => {
      expect(archestraApiSdk.updateTeamMember).toHaveBeenCalledWith({
        path: { id: "team-1", userId: "u-01" },
        body: { role: "admin" },
      });
      expect(archestraApiSdk.removeTeamMember).toHaveBeenCalledWith({
        path: { id: "team-1", userId: "u-21" },
      });
    });
  });

  it("does not offer a user who is already a member on another page", async () => {
    serveMembers(largeRoster(45));
    vi.mocked(useMemberSearch).mockReturnValue({
      users: [
        { userId: "u-30", name: "Member 30", email: "member30@example.com" },
        { userId: "u-99", name: "Nadia Okafor", email: "nadia@example.com" },
      ],
      isSearching: false,
      onSearchQueryChange: vi.fn(),
      emptyMessage: "",
      // biome-ignore lint/suspicious/noExplicitAny: partial hook result stub
    } as any);
    const user = await setupUserEvent();
    renderDialog();
    await user.click(screen.getByRole("button", { name: "Members" }));
    await screen.findByText("Member 01");

    await user.click(screen.getByRole("button", { name: "Add members" }));
    // A combobox takes no accessible name from its content.
    await user.click(screen.getByText("Choose people to add"));

    await waitFor(() => {
      expect(screen.getByRole("option", { name: /Member 30/ })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
    });
    expect(
      screen.getByRole("option", { name: /Nadia Okafor/ }),
    ).not.toHaveAttribute("aria-disabled", "true");
  });

  it("adds several people at once with the chosen team role", async () => {
    vi.mocked(useMemberSearch).mockReturnValue({
      users: [
        { userId: "u-98", name: "Ola Berg", email: "ola@example.com" },
        { userId: "u-99", name: "Nadia Okafor", email: "nadia@example.com" },
      ],
      isSearching: false,
      onSearchQueryChange: vi.fn(),
      emptyMessage: "",
      // biome-ignore lint/suspicious/noExplicitAny: partial hook result stub
    } as any);
    const user = await setupUserEvent();
    renderDialog();
    await user.click(screen.getByRole("button", { name: "Members" }));
    await screen.findByText("Rosa Lindqvist");

    await user.click(screen.getByRole("button", { name: "Add members" }));
    await user.click(screen.getByText("Choose people to add"));
    await user.click(await screen.findByRole("option", { name: /Ola Berg/ }));
    await user.click(screen.getByRole("option", { name: /Nadia Okafor/ }));
    await user.keyboard("{Escape}");
    await user.click(
      screen.getByRole("combobox", { name: "Team role for new members" }),
    );
    await user.click(await screen.findByRole("option", { name: /^Admin/ }));
    await user.click(screen.getByRole("button", { name: "Add 2" }));

    expect(screen.getAllByText("New")).toHaveLength(2);
    expect(await findSummary(/^3 members · 2 admins/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => {
      for (const userId of ["u-98", "u-99"]) {
        expect(archestraApiSdk.addTeamMember).toHaveBeenCalledWith(
          expect.objectContaining({
            path: { id: "team-1" },
            body: expect.objectContaining({ userId, role: "admin" }),
          }),
        );
      }
    });
  });
});
