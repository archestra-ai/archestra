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
    };
  }) => {
    if (query?.search && holdSearch) await holdSearch;
    const limit = query?.limit ?? 20;
    const offset = query?.offset ?? 0;
    const matches = roster.filter(
      (member) =>
        (!query?.search ||
          member.name.toLowerCase().includes(query.search.toLowerCase())) &&
        (!query?.userIds || query.userIds.includes(member.userId)),
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
  it("shows labels without an Advanced section", async () => {
    renderDialog();

    expect(screen.getByLabelText("Label key")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Advanced" }),
    ).not.toBeInTheDocument();
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

  it("labels the role control by what it grants, never as an RBAC role name", async () => {
    const user = await setupUserEvent();
    renderDialog();
    await user.click(screen.getByRole("button", { name: "Members" }));

    const trigger = await findRoleTrigger(/not able to edit team/i);
    await user.click(trigger);

    const listbox = await screen.findByRole("listbox");
    expect(
      within(listbox).getByRole("option", { name: "Able to edit team" }),
    ).toBeInTheDocument();
    expect(
      within(listbox).getByRole("option", { name: "Not able to edit team" }),
    ).toBeInTheDocument();

    // The two stored values share their names with organization-wide RBAC
    // roles. Surfacing those names here is the confusion this wording exists
    // to prevent, so no option may be labelled with one.
    for (const option of within(listbox).getAllByRole("option")) {
      expect(option).not.toHaveAccessibleName("Admin");
      expect(option).not.toHaveAccessibleName("Member");
    }
  });

  it("still sends the stored role value when the new label is chosen", async () => {
    const user = await setupUserEvent();
    renderDialog();
    await user.click(screen.getByRole("button", { name: "Members" }));

    await user.click(await findRoleTrigger(/not able to edit team/i));
    await user.click(
      await screen.findByRole("option", { name: "Able to edit team" }),
    );
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(archestraApiSdk.updateTeamMember).toHaveBeenCalledWith({
        path: { id: "team-1", userId: "u-1" },
        body: { role: "admin" },
      });
    });
  });

  it("explains what syncs and what does not, and jumps to External Group Sync", async () => {
    const user = await setupUserEvent();
    renderDialog();
    await user.click(screen.getByRole("button", { name: "Members" }));

    const note = (await screen.findByText(/add members manually/i)).closest(
      "p",
    );
    // The docs link appends screen-reader-only text, so match around it.
    expect(note).toHaveTextContent(
      /External Group Sync to sync membership. Configure roles through Role Mapping/,
    );

    await user.click(
      within(note as HTMLElement).getByRole("button", {
        name: "External Group Sync",
      }),
    );
    // The section behind the jump is enterprise-gated in this harness, so the
    // license fallback standing in for it proves the navigation happened.
    expect(
      await screen.findByText(/Team Sync is an enterprise feature/i),
    ).toBeInTheDocument();
  });
});

describe("TeamManagementDialog members of a large team", () => {
  it("pages and searches members on the server instead of loading them all", async () => {
    serveMembers(largeRoster(45));
    const user = await setupUserEvent();
    renderDialog();
    await user.click(screen.getByRole("button", { name: "Members" }));

    expect(await screen.findByText("Current Members (45)")).toBeInTheDocument();
    expect(screen.getByText("Member 20")).toBeInTheDocument();
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
    expect(
      await screen.findByText("Current Members (6 matching)"),
    ).toBeInTheDocument();
    expect(screen.getByText("Member 45")).toBeInTheDocument();
    expect(archestraApiSdk.getTeamMembers).not.toHaveBeenCalled();
  });

  it("keeps the header on the shown members while a search loads", async () => {
    let releaseSearch = () => {};
    serveMembers(largeRoster(45), {
      holdSearch: new Promise<void>((resolve) => {
        releaseSearch = resolve;
      }),
    });
    const user = await setupUserEvent();
    renderDialog();
    await user.click(screen.getByRole("button", { name: "Members" }));
    expect(await screen.findByText("Current Members (45)")).not.toHaveClass(
      "opacity-60",
    );

    await user.type(
      screen.getByRole("textbox", { name: "Search members" }),
      "member 4",
    );
    await waitFor(() =>
      expect(screen.getByText("Current Members (45)")).toHaveClass(
        "opacity-60",
      ),
    );
    expect(screen.queryByText(/matching/)).not.toBeInTheDocument();

    releaseSearch();
    expect(
      await screen.findByText("Current Members (6 matching)"),
    ).not.toHaveClass("opacity-60");
  });

  it("keeps member changes staged on other pages and saves them all", async () => {
    serveMembers(largeRoster(45));
    const user = await setupUserEvent();
    renderDialog();
    await user.click(screen.getByRole("button", { name: "Members" }));
    await screen.findByText("Member 01");

    // Page 1: promote the first member.
    await user.click(await findRoleTrigger(/not able to edit team/i));
    await user.click(
      await screen.findByRole("option", { name: "Able to edit team" }),
    );
    // Page 2: remove its first member.
    await user.click(
      screen.getAllByRole("button", { name: "Go to next page" })[0],
    );
    await screen.findByText("Member 21");
    await user.click(
      screen.getAllByRole("button", { name: "Remove member" })[0],
    );
    expect(screen.queryByText("Member 21")).not.toBeInTheDocument();
    expect(screen.getByText("Current Members (44)")).toBeInTheDocument();

    // Back on page 1 the promotion is still staged.
    await user.click(
      screen.getAllByRole("button", { name: "Go to previous page" })[0],
    );
    expect(await findRoleTrigger(/^able to edit team/i)).toBeInTheDocument();
    expect(screen.getByText("pending")).toBeInTheDocument();

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

    // A combobox takes no accessible name from its content.
    await user.click(screen.getByText("Select a user"));

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
});
