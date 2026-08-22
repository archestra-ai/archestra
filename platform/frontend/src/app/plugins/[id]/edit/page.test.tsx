import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query");
vi.mock("@/lib/organization.query");
vi.mock("@/lib/plugins/plugin.query");
vi.mock("@/lib/teams/team.query");

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
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

const IMPORTED_PLUGIN = {
  id: "plugin-1",
  displayName: "Imported plugin",
  description: "Owned by its source repository",
  pluginSlug: "imported-plugin",
  sourceKind: "github",
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

beforeEach(() => {
  updateMock.mockReset();
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
  it("only edits access for an imported plugin", () => {
    render(<PluginEditPage id={IMPORTED_PLUGIN.id} />);

    expect(
      screen.getByText("Choose who can discover and install the plugin."),
    ).toBeVisible();
    expect(screen.queryByLabelText("Display name")).not.toBeInTheDocument();
    expect(screen.queryByText("Content")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Payload bytes are owned by the GitHub source/),
    ).not.toBeInTheDocument();
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
