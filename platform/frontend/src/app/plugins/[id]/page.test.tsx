import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation");
vi.mock("@/lib/config/config.query");
vi.mock("@/lib/plugins/plugin.query");
vi.mock("@/lib/github-app-config.query");
vi.mock("@/lib/github-pat.query");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/organization.query");
vi.mock("@/components/editor");

import { useRouter, useSearchParams } from "next/navigation";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useGithubAppConfigs } from "@/lib/github-app-config.query";
import { useGithubPats } from "@/lib/github-pat.query";
import { useAppearanceSettings } from "@/lib/organization.query";
import {
  type PluginDetail,
  useApplyGithubPluginUpdate,
  useDeletePlugin,
  usePlugin,
  usePreviewGithubPluginUpdate,
  useTriggerPluginGithubSync,
  useUpdatePlugin,
  useUpdatePluginGithubSync,
} from "@/lib/plugins/plugin.query";
import PluginDetailPage from "./page.client";

const BASE_PLUGIN = {
  id: "plugin-1",
  organizationId: "org-1",
  displayName: "Session guard",
  description: "Blocks risky commands.",
  pluginSlug: "session-guard",
  clientType: "claude-code",
  supportedPlatforms: ["posix"],
  scope: "org",
  teams: [],
  users: [],
  authorId: "user-1",
  enabled: true,
  files: [
    {
      path: "hooks/hooks.json",
      content: "{}",
      encoding: "utf8",
      mode: "100644",
    },
    {
      path: "statusline.ps1",
      content: "Write-Output 'ready'",
      encoding: "utf8",
      mode: "100644",
    },
  ],
  sourceKind: "manual",
  sourceId: null,
  sourceRepo: null,
  sourceRef: null,
  sourceSha: null,
  sourceSubdir: null,
  sourceMarketplaceRepo: null,
  sourceMarketplacePluginName: null,
  githubSyncInterval: null,
  githubSyncRef: null,
  githubPatId: null,
  githubAppConfigId: null,
  lastSyncedAt: null,
  lastSyncError: null,
  pendingSourceSha: null,
  pendingContentHash: null,
  pendingDetectedAt: null,
  contentHash: "abc123",
  approvedContentHash: "abc123",
  approvedAt: null,
  approvedBy: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
} as unknown as PluginDetail;

function renderPage(plugin: PluginDetail) {
  vi.mocked(usePlugin).mockReturnValue({
    data: plugin,
    isPending: false,
  } as unknown as ReturnType<typeof usePlugin>);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <PluginDetailPage id={plugin.id} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.mocked(useRouter).mockReturnValue({
    push: vi.fn(),
  } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams() as ReturnType<typeof useSearchParams>,
  );
  vi.mocked(useFeature).mockReturnValue(true);
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "user-1" } },
  } as unknown as ReturnType<typeof useSession>);
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
  } as unknown as ReturnType<typeof useHasPermissions>);
  vi.mocked(useAppearanceSettings).mockReturnValue({
    data: undefined,
  } as unknown as ReturnType<typeof useAppearanceSettings>);
  vi.mocked(useGithubAppConfigs).mockReturnValue({
    data: [],
  } as unknown as ReturnType<typeof useGithubAppConfigs>);
  vi.mocked(useGithubPats).mockReturnValue({
    data: [],
  } as unknown as ReturnType<typeof useGithubPats>);
  const mutationStub = {
    mutateAsync: vi.fn(),
    mutate: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    data: undefined,
  };
  vi.mocked(useDeletePlugin).mockReturnValue(
    mutationStub as unknown as ReturnType<typeof useDeletePlugin>,
  );
  vi.mocked(useApplyGithubPluginUpdate).mockReturnValue(
    mutationStub as unknown as ReturnType<typeof useApplyGithubPluginUpdate>,
  );
  vi.mocked(usePreviewGithubPluginUpdate).mockReturnValue(
    mutationStub as unknown as ReturnType<typeof usePreviewGithubPluginUpdate>,
  );
  vi.mocked(useTriggerPluginGithubSync).mockReturnValue(
    mutationStub as unknown as ReturnType<typeof useTriggerPluginGithubSync>,
  );
  vi.mocked(useUpdatePluginGithubSync).mockReturnValue(
    mutationStub as unknown as ReturnType<typeof useUpdatePluginGithubSync>,
  );
  updateMutateAsync.mockResolvedValue({ id: "plugin-1" });
  vi.mocked(useUpdatePlugin).mockReturnValue({
    mutateAsync: updateMutateAsync,
    isPending: false,
  } as unknown as ReturnType<typeof useUpdatePlugin>);
});

const updateMutateAsync = vi.fn();

describe("PluginDetailPage", () => {
  it("is the plugin's settings rather than a read-only view of them", async () => {
    const user = userEvent.setup();
    renderPage(BASE_PLUGIN);

    // Metadata is fields, not facts, and the payload is editable beneath them.
    expect(screen.getByLabelText("Display name")).toHaveValue("Session guard");
    expect(screen.getByLabelText("Description")).toHaveValue(
      "Blocks risky commands.",
    );
    expect(screen.getByText("hooks/hooks.json")).toBeVisible();
    const file = screen.getByRole("textbox", { name: "File contents" });
    expect(file).toHaveValue("{}");
    expect(file).not.toHaveAttribute("readonly");

    // Who can discover it is the end of the same page, not a second route.
    expect(screen.getByText("Who can discover this plugin")).toBeVisible();

    // Nothing sends the reader anywhere to edit: this is where editing happens.
    expect(
      screen.queryByRole("link", { name: "Edit" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /Configuration/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Install" })).toBeVisible();
    // A manual plugin has no source to point at, so no such panel.
    expect(screen.queryByText("GitHub source")).not.toBeInTheDocument();

    // Clean: there is nothing to write yet.
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    await user.clear(screen.getByLabelText("Display name"));
    await user.type(screen.getByLabelText("Display name"), "Session sentry");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(updateMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: "Session sentry" }),
    );
  });

  it("locks a repository-owned plugin and says where to change it instead", async () => {
    const user = userEvent.setup();
    renderPage({
      ...BASE_PLUGIN,
      sourceKind: "github",
      sourceRepo: "acme/hooks",
      githubSyncInterval: "1d",
    });

    expect(
      screen.getByRole("textbox", { name: "File contents" }),
    ).toHaveAttribute("readonly");
    // The source that owns those bytes is editable, directly under them.
    expect(screen.getByText("GitHub source")).toBeVisible();
    expect(screen.getByLabelText("Repository URL")).toHaveValue("acme/hooks");

    // A field that silently refuses keystrokes reads as broken, so the reason
    // is on the field itself.
    await user.hover(screen.getByLabelText("Display name"));
    // Radix renders the reason twice — once visibly, once for screen readers.
    expect(
      (await screen.findAllByText(/synced from GitHub/i))[0],
    ).toBeVisible();
  });

  it("offers no save row to someone who may not change this plugin", () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
    } as unknown as ReturnType<typeof useHasPermissions>);
    renderPage(BASE_PLUGIN);

    expect(
      screen.queryByRole("button", { name: "Save changes" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/view this plugin's configuration but not change it/i),
    ).toBeVisible();
  });

  it("keeps GitHub update controls in a compact header dialog", async () => {
    const user = userEvent.setup();
    renderPage({
      ...BASE_PLUGIN,
      sourceKind: "github",
      sourceRepo: "acme/hooks",
      sourceSha: "a".repeat(40),
      githubSyncInterval: "1d",
      pendingSourceSha: "b".repeat(40),
      pendingDetectedAt: "2026-08-20T00:00:00.000Z",
    });

    expect(screen.getByLabelText("Repository URL")).toHaveValue("acme/hooks");
    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Review update" }));
    expect(
      screen.getByRole("dialog", { name: "GitHub updates" }),
    ).toBeVisible();
    expect(
      screen.getByRole("combobox", { name: "Check cadence" }),
    ).toBeVisible();
    expect(screen.getByText("Update ready for review")).toBeVisible();
    expect(screen.getByText("Checked against GitHub")).toBeVisible();
    expect(
      screen.queryByText("Update candidate ready for review"),
    ).not.toBeInTheDocument();
  });

  it("uses PowerShell syntax highlighting for ps1 payload files", async () => {
    const user = userEvent.setup();
    renderPage(BASE_PLUGIN);

    await user.click(screen.getByRole("button", { name: "statusline.ps1" }));

    expect(
      screen.getByRole("textbox", { name: "File contents" }),
    ).toHaveAttribute("data-language", "powershell");
  });

  it("attributes the vendor's own plugin to its author, not the deployment", async () => {
    const user = userEvent.setup();
    vi.mocked(useAppearanceSettings).mockReturnValue({
      data: { appName: "Northstar" },
    } as unknown as ReturnType<typeof useAppearanceSettings>);
    renderPage({
      ...BASE_PLUGIN,
      sourceKind: "github",
      sourceRepo: "archestra-ai/OpenAPPA",
      sourceMarketplaceRepo: "archestra-ai/OpenAPPA",
      sourceMarketplacePath: ".claude-plugin/marketplace.json",
      sourceMarketplacePluginName: "appa-runtime",
    });

    // The deployment is rebranded "Northstar" above, but the plugin is published
    // by Archestra either way — rebranding must not rewrite someone else's byline.
    expect(screen.getByText("Archestra")).toBeVisible();
    expect(screen.queryByText("Northstar")).not.toBeInTheDocument();
    expect(screen.queryByText("Imported from GitHub")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.getByRole("menuitem", { name: "Updates" })).toBeVisible();
  });
});
