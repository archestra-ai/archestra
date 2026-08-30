import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config/config", () => ({
  default: {
    api: {
      externalProxyUrls: ["https://example.test/v1"],
      internalProxyUrl: "http://backend:9000/v1",
    },
  },
}));
vi.mock("@/lib/connection-setup.query");
vi.mock("@/lib/organization.query");

import { useCreateConnectionSetup } from "@/lib/connection-setup.query";
import {
  useAppearanceSettings,
  useOrganization,
} from "@/lib/organization.query";
import { PluginInstallDialog } from "./plugin-install-dialog";

const createSetup = vi.fn();

beforeEach(() => {
  createSetup.mockReset();
  createSetup.mockResolvedValue({
    command: "curl -fsSL https://example.test/setup | bash",
    expiresAt: "2026-08-22T10:15:00.000Z",
  });
  vi.mocked(useOrganization).mockReturnValue({
    data: { connectionBaseUrls: null },
    isPending: false,
  } as unknown as ReturnType<typeof useOrganization>);
  vi.mocked(useAppearanceSettings).mockReturnValue({
    data: undefined,
  } as unknown as ReturnType<typeof useAppearanceSettings>);
  vi.mocked(useCreateConnectionSetup).mockReturnValue({
    mutateAsync: createSetup,
    isPending: false,
    reset: vi.fn(),
  } as unknown as ReturnType<typeof useCreateConnectionSetup>);
});

describe("PluginInstallDialog", () => {
  it("generates a plugin-only install command without the connection page", async () => {
    render(
      <PluginInstallDialog
        plugins={[
          {
            id: "plugin-1",
            displayName: "Session guard",
            clientType: "claude-code",
            supportedPlatforms: ["posix"],
          },
        ]}
        open
        onOpenChange={() => {}}
      />,
    );

    expect(screen.getByText("macOS / Linux")).toBeVisible();
    expect(
      screen.queryByRole("combobox", { name: "Target platform" }),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(createSetup).toHaveBeenCalledWith({
        clientId: "claude-code",
        platform: "macos",
        baseUrl: "https://example.test/v1",
        pluginIds: ["plugin-1"],
      }),
    );
    expect(
      await screen.findByText("curl -fsSL https://example.test/setup | bash"),
    ).toBeVisible();
  });

  it("reuses the Connection review row Change interaction", async () => {
    const user = userEvent.setup();
    render(
      <PluginInstallDialog
        plugins={[
          {
            id: "plugin-2",
            displayName: "Cross-platform plugin",
            clientType: "claude-code",
            supportedPlatforms: ["posix", "windows"],
          },
        ]}
        open
        onOpenChange={() => {}}
      />,
    );

    expect(
      screen.queryByRole("combobox", { name: "Target platform" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Change" }));
    expect(
      screen.getByRole("combobox", { name: "Target platform" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(
      screen.queryByRole("combobox", { name: "Target platform" }),
    ).not.toBeInTheDocument();
  });

  it("preselects the detected operating system when it is compatible", async () => {
    const platformSpy = vi
      .spyOn(window.navigator, "platform", "get")
      .mockReturnValue("Win32");

    try {
      render(
        <PluginInstallDialog
          plugins={[
            {
              id: "plugin-windows",
              displayName: "Cross-platform plugin",
              clientType: "claude-code",
              supportedPlatforms: ["posix", "windows"],
            },
          ]}
          open
          onOpenChange={() => {}}
        />,
      );

      await waitFor(() =>
        expect(createSetup).toHaveBeenCalledWith(
          expect.objectContaining({ platform: "windows" }),
        ),
      );
      expect(screen.getByText("Windows")).toBeVisible();
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("generates one setup command for a compatible Plugin selection", async () => {
    render(
      <PluginInstallDialog
        plugins={[
          {
            id: "plugin-a",
            displayName: "Plugin A",
            clientType: "claude-code",
            supportedPlatforms: ["posix"],
          },
          {
            id: "plugin-b",
            displayName: "Plugin B",
            clientType: "claude-code",
            supportedPlatforms: ["posix", "windows"],
          },
        ]}
        open
        onOpenChange={() => {}}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Install 2 plugins" }),
    ).toBeVisible();
    await waitFor(() =>
      expect(createSetup).toHaveBeenCalledWith(
        expect.objectContaining({
          clientId: "claude-code",
          platform: "macos",
          pluginIds: ["plugin-a", "plugin-b"],
        }),
      ),
    );
  });
});
