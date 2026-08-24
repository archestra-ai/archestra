import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation");
vi.mock("@/lib/config/config.query", () => ({ useFeature: () => true }));
vi.mock("@/lib/hooks/use-app-name", () => ({
  useAppName: () => "Northstar",
}));
vi.mock("@/lib/auth/auth.query", () => ({
  useSession: () => ({ data: { user: { id: "user-1" } } }),
  useHasPermissions: () => ({ data: true }),
  // The Agents-section tab bar at the top of the page asks which of its pages
  // this reader may open.
  usePermissionMap: () => ({
    "/agents": true,
    "/skills": true,
    "/plugins": true,
  }),
}));
vi.mock("@/components/resource-scope-filter", () => ({
  ActiveFilterBadges: () => null,
  ResourceScopeFilter: () => <button type="button">Visibility filter</button>,
  useScopeFilterParams: () => ({
    scope: undefined,
    teamIds: undefined,
    authorIds: undefined,
    excludeAuthorIds: undefined,
    excludeOtherPersonal: false,
    hasActiveScopeFilters: false,
  }),
}));
vi.mock("@/components/search-input", () => ({
  SearchInput: () => <input aria-label="Search plugins" />,
}));
vi.mock("./_parts/plugin-install-dialog", () => ({
  PluginInstallDialog: () => null,
}));
vi.mock("@/lib/plugins/plugin.query", () => ({
  usePlugins: () => ({
    data: [PLUGIN],
    isPending: false,
    isFetching: false,
    isLoadingError: false,
    refetch: vi.fn(),
  }),
  useBulkDeletePlugins: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useBulkUpdatePluginVisibility: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useDeletePlugin: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import PluginsPage from "./page.client";

const PLUGIN = vi.hoisted(() => ({
  id: "plugin-1",
  organizationId: "org-1",
  authorId: "user-1",
  scope: "org",
  clientType: "claude-code",
  supportedPlatforms: ["posix", "windows"],
  pluginSlug: "policy-runtime",
  displayName: "Policy Runtime",
  description: "Applies approved policy hooks.",
  contentHash: "hash-1",
  sourceKind: "github",
  sourceRepo: "archestra-ai/OpenAPPA",
  sourceRef: "main",
  sourceSha: "abc123",
  sourceSubdir: null,
  sourceExclude: [],
  sourceMarketplaceRepo: "archestra-ai/OpenAPPA",
  sourceMarketplacePath: ".claude-plugin/marketplace.json",
  sourceMarketplacePluginName: "appa-runtime",
  githubSyncInterval: "1h",
  githubSyncRef: "main",
  lastSyncedAt: "2026-08-23T18:00:00.000Z",
  pendingSourceSha: null,
  pendingContentHash: null,
  pendingDetectedAt: null,
  sourceId: "default-policy-runtime",
  approvedContentHash: "hash-1",
  approvedAt: null,
  approvedBy: null,
  enabled: true,
  createdAt: "2026-08-01T12:00:00.000Z",
  updatedAt: "2026-08-23T18:00:00.000Z",
  deletedAt: null,
  teams: [],
  users: [],
  fileCount: 13,
}));

describe("PluginsPage", () => {
  beforeEach(() => {
    vi.mocked(useRouter).mockReturnValue({
      push: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(usePathname).mockReturnValue("/plugins");
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as ReturnType<typeof useSearchParams>,
    );
  });

  it("groups related facts into a compact, white-labelled table", () => {
    render(<PluginsPage />);

    for (const name of [
      "Plugin",
      "Compatibility",
      "Visibility",
      "Source",
      "Activity",
      "Actions",
    ]) {
      expect(screen.getByRole("columnheader", { name })).toBeInTheDocument();
    }
    for (const removed of ["Client", "Platforms", "Files", "Updated"]) {
      expect(
        screen.queryByRole("columnheader", { name: removed }),
      ).not.toBeInTheDocument();
    }
    expect(screen.getByText("Northstar")).toBeVisible();
    expect(screen.getByText("13 files")).toBeVisible();
  });

  it("keeps secondary filters behind More filters until applied", async () => {
    const user = userEvent.setup();
    render(<PluginsPage />);

    expect(
      screen.queryByRole("combobox", { name: "Filter by platform" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "More filters" }));

    expect(
      screen.getByRole("combobox", { name: "Filter by platform" }),
    ).toBeVisible();
    expect(
      screen.getByRole("combobox", { name: "Filter by source" }),
    ).toBeVisible();
    expect(
      screen.getByRole("combobox", { name: "Filter by repository" }),
    ).toBeVisible();
  });
});
