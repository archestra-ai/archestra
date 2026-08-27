import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockUseFeature } = vi.hoisted(() => ({ mockUseFeature: vi.fn() }));

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query", () => ({
  useFeature: mockUseFeature,
}));
vi.mock("@/lib/hooks/use-app-name");
vi.mock("@/lib/organization.query");
// The scope check behind Edit/Delete asks which teams the caller belongs to.
vi.mock("@/lib/teams/team.query");
vi.mock("@/lib/skills/skill.query", () => ({
  useAllMatchingSkills: () => ({ data: [] }),
  useBulkDeleteSkills: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSkillsPaginated: vi.fn(),
  useSkillSourceRepos: vi.fn(),
  useExternalMcpSkills: () => ({ data: [], isPending: false }),
  usePluginSkills: vi.fn(),
  useRestoreSkill: vi.fn(),
  usePermanentlyDeleteSkill: vi.fn(),
}));
// Filter chrome reads the URL and the org's teams; the row actions are what
// this file is about.
vi.mock("@/components/resource-scope-filter", () => ({
  ActiveFilterBadges: () => null,
  ResourceDeletedStatusFilter: () => null,
  ResourceScopeFilter: () => null,
  useScopeFilterParams: () => ({ hasActiveScopeFilters: false }),
}));
vi.mock("@/components/search-input", () => ({ SearchInput: () => null }));
vi.mock("./_parts/skill-version-history-dialog", () => ({
  SkillVersionHistoryDialog: () => null,
}));
vi.mock("./_parts/delete-skill-dialog", () => ({
  DeleteSkillDialog: () => null,
}));

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  useHasPermissions,
  useMissingPermissions,
  useSession,
} from "@/lib/auth/auth.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useIsGlobalAdmin } from "@/lib/organization.query";
import {
  usePermanentlyDeleteSkill,
  usePluginSkills,
  useRestoreSkill,
  useSkillSourceRepos,
  useSkillsPaginated,
} from "@/lib/skills/skill.query";
import { useMyTeams } from "@/lib/teams/team.query";
import SkillsPage from "./page.client";

const MINE = {
  id: "skill-1",
  name: "pdf-tools",
  description: "Work with PDFs.",
  scope: "personal",
  authorId: "user-1",
  authorName: "Me",
  sourceType: "manual",
  sourceRef: null,
  githubSyncInterval: null,
  lastSyncedAt: null,
  lastSyncError: null,
  templated: false,
  compatibility: null,
  fileCount: 2,
  usageCount: 3,
  usageUserCount: 1,
  lastUsedAt: null,
  deletedAt: null,
  teams: [],
  users: [],
  environments: [],
};

/** Somebody else's personal skill: `skill:update` does not reach it. */
const SOMEONE_ELSES = {
  ...MINE,
  id: "skill-2",
  name: "sql-helper",
  authorId: "user-99",
  authorName: "Dana",
};

function mockSkills(data: unknown[]) {
  vi.mocked(useSkillsPaginated).mockReturnValue({
    data: { data, pagination: { total: data.length } },
    isPending: false,
    isFetching: false,
    isLoadingError: false,
    refetch: vi.fn(),
    // biome-ignore lint/suspicious/noExplicitAny: partial query result is enough
  } as any);
}

/**
 * Answers every permission question yes, apart from the `skill:admin` and
 * `skill:team-admin` oversight grants, which are what the ownership check
 * actually turns on.
 */
function mockPermissions({ skillAdmin }: { skillAdmin: boolean }) {
  vi.mocked(useHasPermissions).mockImplementation(
    (permissions: Record<string, string[]>) => {
      const actions = permissions.skill ?? [];
      const asksForOversight =
        actions.includes("admin") || actions.includes("team-admin");
      return {
        data: asksForOversight ? skillAdmin : true,
        // biome-ignore lint/suspicious/noExplicitAny: partial query result is enough
      } as any;
    },
  );
}

const openRowMenu = (skillName: string) =>
  userEvent.click(
    screen.getByRole("button", { name: `More actions ${skillName}` }),
  );

describe("SkillsPage rows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseFeature.mockReturnValue(false);
    vi.mocked(useRouter).mockReturnValue({
      push: vi.fn(),
      replace: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(usePathname).mockReturnValue("/skills");
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as ReturnType<typeof useSearchParams>,
    );
    vi.mocked(useAppName).mockReturnValue("Archestra");
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: "user-1" } },
      // biome-ignore lint/suspicious/noExplicitAny: partial session is enough
    } as any);
    // Every RBAC answer is yes except the two oversight grants, so anything
    // still refused below was refused by the ownership check and by nothing
    // else.
    mockPermissions({ skillAdmin: false });
    vi.mocked(useMissingPermissions).mockReturnValue({});
    vi.mocked(useMyTeams).mockReturnValue({
      data: [],
      // biome-ignore lint/suspicious/noExplicitAny: partial query result is enough
    } as any);
    vi.mocked(useIsGlobalAdmin).mockReturnValue({
      isGlobalAdmin: false,
      isLoading: false,
    });
    vi.mocked(useSkillSourceRepos).mockReturnValue({
      data: { repos: [] },
      // biome-ignore lint/suspicious/noExplicitAny: partial query result is enough
    } as any);
    vi.mocked(useRestoreSkill).mockReturnValue({
      mutate: vi.fn(),
      // biome-ignore lint/suspicious/noExplicitAny: partial mutation is enough
    } as any);
    vi.mocked(usePermanentlyDeleteSkill).mockReturnValue({
      mutateAsync: vi.fn(),
      isPending: false,
      // biome-ignore lint/suspicious/noExplicitAny: partial mutation is enough
    } as any);
    vi.mocked(usePluginSkills).mockReturnValue({
      data: [],
      isFetching: false,
      // biome-ignore lint/suspicious/noExplicitAny: partial query result is enough
    } as any);
    mockSkills([MINE]);
  });

  /**
   * Skills used to render five icon buttons in the row, Delete among them,
   * where the agent rows render two and a menu. Same table, same job, two
   * dialects.
   */
  it("shows Chat and Edit in the row and folds the rest into the row menu", async () => {
    render(<SkillsPage />);

    expect(screen.queryByText("Standalone skills")).not.toBeInTheDocument();
    expect(screen.queryByText("Skills from plugins")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Chat pdf-tools")).toBeInTheDocument();
    expect(screen.getByLabelText("Edit pdf-tools")).toBeInTheDocument();
    // Delete is one click away from Edit no longer.
    expect(screen.queryByLabelText("Delete pdf-tools")).toBeNull();

    await openRowMenu("pdf-tools");

    expect(screen.getByRole("menuitem", { name: "Usage" })).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Version history" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Delete" }),
    ).toBeInTheDocument();
  });

  it("shows Skills from plugins only when the plugins feature is enabled", () => {
    mockUseFeature.mockImplementation((name: string) => name === "plugins");
    vi.mocked(usePluginSkills).mockReturnValue({
      data: [
        {
          source: "plugin",
          pluginId: "11111111-1111-4111-8111-111111111111",
          pluginName: "STE bundle",
          pluginSlug: "ste-bundle-11111111",
          pluginEnabled: true,
          scope: "org",
          clientType: "claude-code",
          supportedPlatforms: ["posix"],
          skillPath: "skills/ste-writing",
          name: "ste-writing",
          description: "Write plainly.",
          compatibility: null,
          fileCount: 2,
        },
      ],
      isFetching: false,
      // biome-ignore lint/suspicious/noExplicitAny: partial query result is enough
    } as any);

    render(<SkillsPage />);

    expect(screen.getByText("Skills from plugins")).toBeInTheDocument();
    expect(screen.getByText("ste-writing")).toBeInTheDocument();
  });

  it("refuses Edit and Delete on somebody else's skill, with the reason", async () => {
    // Skills were the only agent-shaped entity with no ownership gate in the
    // frontend: `skill:update` alone lit up Edit on every row and the save
    // came back 403.
    mockSkills([SOMEONE_ELSES]);
    render(<SkillsPage />);

    expect(screen.getByLabelText("Edit sql-helper")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    // Chat is not a mutation, so it stays available.
    expect(screen.getByLabelText("Chat sql-helper")).not.toHaveAttribute(
      "aria-disabled",
    );

    await openRowMenu("sql-helper");

    expect(screen.getByRole("menuitem", { name: /Delete/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    // One description per refused control: the row's Edit and the menu's Delete.
    expect(screen.getAllByText(/Only this skill's author/)).toHaveLength(2);
  });

  it("lets a skill admin edit a skill they do not own", () => {
    // `skill:admin` is the oversight grant the backend honours, so the row
    // must not refuse what the API would accept.
    mockPermissions({ skillAdmin: true });
    mockSkills([SOMEONE_ELSES]);
    render(<SkillsPage />);

    expect(screen.getByLabelText("Edit sql-helper")).not.toHaveAttribute(
      "aria-disabled",
    );
  });

  it("keeps permanent delete in the trash row's menu, not beside Restore", async () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("status=deleted") as ReturnType<
        typeof useSearchParams
      >,
    );
    mockSkills([{ ...MINE, deletedAt: "2026-08-19T00:00:00.000Z" }]);
    render(<SkillsPage />);

    expect(screen.getByLabelText("Restore pdf-tools")).toBeInTheDocument();
    await openRowMenu("pdf-tools");
    expect(
      screen.getByRole("menuitem", { name: /Delete permanently/ }),
    ).toBeInTheDocument();
  });
});
