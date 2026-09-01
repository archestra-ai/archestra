import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Radix Select uses APIs that jsdom does not implement.
Element.prototype.scrollIntoView = vi.fn();
Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
Element.prototype.setPointerCapture = vi.fn();
Element.prototype.releasePointerCapture = vi.fn();

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query");
vi.mock("@/lib/github-app-config.query");
vi.mock("@/lib/github-pat.query");
vi.mock("@/lib/organization.query");
vi.mock("@/lib/plugins/plugin.query");
vi.mock("@/lib/teams/team.query");

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useGithubAppConfigs } from "@/lib/github-app-config.query";
import { useCreateGithubPat } from "@/lib/github-pat.query";
import {
  useAppearanceSettings,
  useOrganizationMembers,
} from "@/lib/organization.query";
import {
  type PluginDetail,
  usePlugin,
  useUpdatePlugin,
} from "@/lib/plugins/plugin.query";
import { useAssignableTeams } from "@/lib/teams/team.query";
import { PluginEditPage } from "./page.client";

const EXPIRED_PAT_ID = "11111111-1111-4111-8111-111111111111";
const REPLACEMENT_PAT_ID = "22222222-2222-4222-8222-222222222222";

const IMPORTED_PLUGIN = {
  id: "plugin-1",
  displayName: "Imported plugin",
  description: "Owned by its source repository",
  pluginSlug: "imported-plugin",
  sourceKind: "github",
  sourceRepo: "archestra-ai/OpenAPPA",
  githubSyncRef: "main",
  githubSyncInterval: "1d",
  githubPatId: EXPIRED_PAT_ID,
  githubAppConfigId: null,
  enabled: true,
  supportedPlatforms: ["posix"],
  scope: "org",
  teams: [],
  users: [],
  files: [
    {
      path: "hooks/hooks.json",
      content: "{}",
      encoding: "utf8",
      mode: "100644",
    },
  ],
} as unknown as PluginDetail;

const MANUAL_PLUGIN = {
  ...IMPORTED_PLUGIN,
  displayName: "Manual plugin",
  description: "Editable payload",
  sourceKind: "manual",
  clientType: "claude-code",
  files: [
    {
      path: "hooks/hooks.json",
      content: "{}",
      encoding: "utf8",
      mode: "100755",
    },
  ],
} as unknown as PluginDetail;

const updateMock = vi.fn();
const createPatMock = vi.fn();

beforeEach(() => {
  updateMock.mockReset();
  createPatMock.mockReset();
  vi.mocked(useFeature).mockReturnValue(true);
  vi.mocked(usePathname).mockReturnValue(`/plugins/${IMPORTED_PLUGIN.id}/edit`);
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams("step=content") as ReturnType<typeof useSearchParams>,
  );
  vi.mocked(useRouter).mockReturnValue({
    push: vi.fn(),
    replace: vi.fn(),
  } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(usePlugin).mockReturnValue({
    data: IMPORTED_PLUGIN,
    isPending: false,
    isLoadingError: false,
  } as unknown as ReturnType<typeof usePlugin>);
  vi.mocked(useUpdatePlugin).mockReturnValue({
    mutateAsync: updateMock,
  } as unknown as ReturnType<typeof useUpdatePlugin>);
  vi.mocked(useCreateGithubPat).mockReturnValue({
    mutateAsync: createPatMock,
  } as unknown as ReturnType<typeof useCreateGithubPat>);
  vi.mocked(useGithubAppConfigs).mockReturnValue({
    data: [
      {
        id: "33333333-3333-4333-8333-333333333333",
        name: "Archestra GitHub App",
      },
    ],
  } as unknown as ReturnType<typeof useGithubAppConfigs>);
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
  } as unknown as ReturnType<typeof useHasPermissions>);
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "user-1" } },
  } as unknown as ReturnType<typeof useSession>);
  vi.mocked(useOrganizationMembers).mockReturnValue({
    data: [],
  } as unknown as ReturnType<typeof useOrganizationMembers>);
  vi.mocked(useAppearanceSettings).mockReturnValue({
    data: undefined,
  } as unknown as ReturnType<typeof useAppearanceSettings>);
  vi.mocked(useAssignableTeams).mockReturnValue({
    data: [],
  } as unknown as ReturnType<typeof useAssignableTeams>);
});

describe("PluginEditPage", () => {
  it("leaves empty authentication unchanged while editing GitHub source settings", async () => {
    const user = userEvent.setup();
    updateMock.mockResolvedValue(IMPORTED_PLUGIN);
    render(<PluginEditPage id={IMPORTED_PLUGIN.id} />);

    expect(
      screen.getByText(
        "Edit the GitHub source, schedule, and who can discover this plugin.",
      ),
    ).toBeVisible();
    expect(screen.getByLabelText("Repository URL")).toHaveValue(
      "archestra-ai/OpenAPPA",
    );
    expect(screen.getByLabelText("Keep in sync")).toHaveTextContent(
      "Once a day",
    );
    expect(screen.getByLabelText("Ref")).toHaveValue("main");
    expect(screen.getByLabelText("Authentication Method")).toHaveTextContent(
      "Personal Access Token",
    );
    expect(screen.getByLabelText("Personal Access Token")).toHaveValue("");
    expect(screen.getByLabelText("Personal Access Token")).toHaveAttribute(
      "placeholder",
      "Leave empty to keep existing token",
    );
    expect(
      screen.getByText(/Leave empty to keep existing credentials unchanged/),
    ).toBeVisible();
    expect(screen.queryByLabelText("Display name")).not.toBeInTheDocument();
    expect(screen.queryByText("Content")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Payload bytes are owned by the GitHub source/),
    ).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText("Repository URL"));
    await user.type(
      screen.getByLabelText("Repository URL"),
      "github.com/acme/plugin",
    );
    await user.clear(screen.getByLabelText("Ref"));
    await user.type(screen.getByLabelText("Ref"), "release");
    await user.click(screen.getByLabelText("Keep in sync"));
    await user.click(screen.getByRole("option", { name: "Every hour" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        githubSource: {
          repoUrl: "github.com/acme/plugin",
          ref: "release",
          syncInterval: "1h",
        },
        scope: "org",
      }),
    );
  });

  it("replaces an expired token with a newly saved credential", async () => {
    const user = userEvent.setup();
    createPatMock.mockResolvedValue({
      id: REPLACEMENT_PAT_ID,
      name: "Replacement token",
    });
    updateMock.mockResolvedValue({
      ...IMPORTED_PLUGIN,
      githubPatId: REPLACEMENT_PAT_ID,
    });
    render(<PluginEditPage id={IMPORTED_PLUGIN.id} />);

    await user.type(
      screen.getByLabelText("Personal Access Token"),
      "ghp_fresh",
    );
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(createPatMock).toHaveBeenCalledWith({
      name: "Imported plugin token",
      token: "ghp_fresh",
    });
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        githubSource: expect.objectContaining({
          authentication: {
            githubAppConfigId: null,
            githubPatId: REPLACEMENT_PAT_ID,
          },
        }),
      }),
    );
  });

  it("switches from the configured token to a GitHub App", async () => {
    const user = userEvent.setup();
    updateMock.mockResolvedValue({
      ...IMPORTED_PLUGIN,
      githubPatId: null,
      githubAppConfigId: "33333333-3333-4333-8333-333333333333",
    });
    render(<PluginEditPage id={IMPORTED_PLUGIN.id} />);

    await user.click(screen.getByLabelText("Authentication Method"));
    await user.click(screen.getByRole("option", { name: "GitHub App" }));
    expect(
      screen.queryByLabelText("Personal Access Token"),
    ).not.toBeInTheDocument();
    await user.click(screen.getByLabelText("GitHub App Configuration"));
    await user.click(
      screen.getByRole("option", { name: "Archestra GitHub App" }),
    );
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        githubSource: expect.objectContaining({
          authentication: {
            githubAppConfigId: "33333333-3333-4333-8333-333333333333",
            githubPatId: null,
          },
        }),
      }),
    );
  });

  it("uses the shared footer outside the card and preserves file metadata", async () => {
    const user = userEvent.setup();
    vi.mocked(usePlugin).mockReturnValue({
      data: MANUAL_PLUGIN,
      isPending: false,
      isLoadingError: false,
    } as unknown as ReturnType<typeof usePlugin>);
    updateMock.mockResolvedValue(MANUAL_PLUGIN);
    render(<PluginEditPage id={MANUAL_PLUGIN.id} />);

    const displayName = screen.getByLabelText("Display name");
    const card = displayName.closest(".rounded-lg.border");
    if (!card) throw new Error("Plugin content card not rendered");
    expect(
      within(card as HTMLElement).queryByRole("button", { name: "Save" }),
    ).not.toBeInTheDocument();

    await user.clear(displayName);
    await user.type(displayName, "Updated plugin");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: "Updated plugin",
        files: [
          expect.objectContaining({
            path: "hooks/hooks.json",
            encoding: "utf8",
            mode: "100755",
          }),
        ],
      }),
    );
  });
});
