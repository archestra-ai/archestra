import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Radix Select uses scrollIntoView and pointer capture
Element.prototype.scrollIntoView = vi.fn();
Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
Element.prototype.setPointerCapture = vi.fn();
Element.prototype.releasePointerCapture = vi.fn();

vi.mock("@/lib/organization.query");
vi.mock("@/lib/auth/auth.query");
// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
vi.mock("@/lib/config/config.query");

// SPDX-SnippetEnd

import {
  useHasPermissions,
  useMissingPermissions,
} from "@/lib/auth/auth.query";
// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import {
  useEnterpriseFeature,
  useFeature,
  useSmallTeamTier,
} from "@/lib/config/config.query";
// SPDX-SnippetEnd
import {
  useOrganization,
  useUpdateMcpSettings,
} from "@/lib/organization.query";
import McpSettingsPage from "./page";

const mockMutateAsync = vi.fn();

function setPermission(hasPermission: boolean) {
  vi.mocked(useHasPermissions).mockReturnValue({
    data: hasPermission,
    isPending: false,
  } as ReturnType<typeof useHasPermissions>);
  vi.mocked(useMissingPermissions).mockReturnValue(
    [] as unknown as ReturnType<typeof useMissingPermissions>,
  );
}

function setOrganization(
  settings: Partial<{
    onlineMcpCatalogEnabled: boolean;
    deviceMcpEnabled: boolean;
    defaultPersonalAgentAccessAllTools: boolean;
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    mcpIdleHibernationEnabled: boolean;
    // SPDX-SnippetEnd
  }> = {},
) {
  vi.mocked(useOrganization).mockReturnValue({
    data: {
      onlineMcpCatalogEnabled: true,
      deviceMcpEnabled: false,
      defaultPersonalAgentAccessAllTools: true,
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      mcpIdleHibernationEnabled: false,
      // SPDX-SnippetEnd
      ...settings,
    },
    isPending: false,
  } as ReturnType<typeof useOrganization>);
}

beforeEach(() => {
  vi.clearAllMocks();
  setPermission(true);
  setOrganization();
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  vi.mocked(useEnterpriseFeature).mockReturnValue(true);
  // The hibernation block only exists when the beta flag is on.
  vi.mocked(useFeature).mockReturnValue(true);
  vi.mocked(useSmallTeamTier).mockReturnValue(
    undefined as ReturnType<typeof useSmallTeamTier>,
  );
  // SPDX-SnippetEnd
  vi.mocked(useUpdateMcpSettings).mockReturnValue({
    mutateAsync: mockMutateAsync,
    isPending: false,
  } as unknown as ReturnType<typeof useUpdateMcpSettings>);
});

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <McpSettingsPage />
    </QueryClientProvider>,
  );
}

/** The select belonging to one settings block, scoped by the block's title. */
function blockSelect(title: string) {
  const section = screen
    .getByRole("heading", { name: title })
    .closest("section");
  if (!section) throw new Error(`No settings block titled "${title}"`);
  return within(section).getByRole("combobox");
}

function blockSwitch(title: string) {
  return screen.getByRole("switch", { name: title });
}

describe("McpSettingsPage", () => {
  it("starts in All mode and saves Custom as a creation default", async () => {
    const user = userEvent.setup();
    renderPage();
    expect(blockSelect("Default personal tool mode")).toHaveTextContent("All");
    await user.click(blockSelect("Default personal tool mode"));
    await user.click(screen.getByRole("option", { name: /^Custom/ }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(mockMutateAsync).toHaveBeenCalledWith({
      defaultPersonalAgentAccessAllTools: false,
    });
  });

  it("loads the saved default and cancels a tool mode change", async () => {
    setOrganization({ defaultPersonalAgentAccessAllTools: false });
    const user = userEvent.setup();
    renderPage();
    expect(blockSelect("Default personal tool mode")).toHaveTextContent(
      "Custom",
    );
    await user.click(blockSelect("Default personal tool mode"));
    await user.click(screen.getByRole("option", { name: /^All/ }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(blockSelect("Default personal tool mode")).toHaveTextContent(
      "Custom",
    );
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it("renders the online catalog setting", () => {
    renderPage();

    expect(screen.getByText("Online MCP catalog")).toBeInTheDocument();
    expect(blockSwitch("Online MCP catalog")).toBeChecked();
  });

  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  it("renders the idle hibernation setting alongside the catalog setting", () => {
    setOrganization({ mcpIdleHibernationEnabled: true });
    renderPage();

    expect(screen.getByText("Idle hibernation")).toBeInTheDocument();
    expect(blockSwitch("Idle hibernation")).toBeChecked();
  });
  // SPDX-SnippetEnd

  it("reflects a disabled online catalog from the organization", () => {
    setOrganization({ onlineMcpCatalogEnabled: false });
    renderPage();

    expect(blockSwitch("Online MCP catalog")).not.toBeChecked();
  });

  it("disables the control when the user cannot update MCP settings", () => {
    setPermission(false);
    renderPage();

    expect(blockSwitch("Online MCP catalog")).toBeDisabled();
    expect(blockSwitch("Device MCP servers")).toBeDisabled();
  });

  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  it("makes hibernation inert without an enterprise licence, leaving the catalog editable", () => {
    vi.mocked(useEnterpriseFeature).mockReturnValue(false);
    renderPage();

    expect(blockSwitch("Idle hibernation")).toBeDisabled();
    expect(blockSwitch("Online MCP catalog")).toBeEnabled();
  });

  it("hides hibernation entirely while the beta flag is off", () => {
    vi.mocked(useFeature).mockReturnValue(false);
    renderPage();

    expect(screen.queryByText("Idle hibernation")).not.toBeInTheDocument();
    expect(blockSwitch("Online MCP catalog")).toBeEnabled();
  });

  it("enables the hibernation control once enterprise core is active", () => {
    renderPage();

    expect(blockSwitch("Idle hibernation")).toBeEnabled();
  });

  it("saves only the settings the user changed", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(blockSwitch("Idle hibernation"));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(mockMutateAsync).toHaveBeenCalledWith({
      mcpIdleHibernationEnabled: true,
    });
  });
  // SPDX-SnippetEnd

  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  it("saves both settings when both changed", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(blockSwitch("Online MCP catalog"));
    await user.click(blockSwitch("Idle hibernation"));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(mockMutateAsync).toHaveBeenCalledWith({
      onlineMcpCatalogEnabled: false,
      mcpIdleHibernationEnabled: true,
    });
  });
  // SPDX-SnippetEnd

  it("requires an explicit device opt-in and saves only that change", async () => {
    const user = userEvent.setup();
    renderPage();
    expect(blockSwitch("Device MCP servers")).not.toBeChecked();
    await user.click(blockSwitch("Device MCP servers"));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(mockMutateAsync).toHaveBeenCalledWith({ deviceMcpEnabled: true });
  });

  it("cancels an unsaved device change and can disable an existing opt-in", async () => {
    setOrganization({ deviceMcpEnabled: true });
    const user = userEvent.setup();
    renderPage();
    await user.click(blockSwitch("Device MCP servers"));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(blockSwitch("Device MCP servers")).toBeChecked();
    expect(mockMutateAsync).not.toHaveBeenCalled();
    await user.click(blockSwitch("Device MCP servers"));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(mockMutateAsync).toHaveBeenCalledWith({ deviceMcpEnabled: false });
  });

  it("shows a loading state instead of the control while the org is pending", () => {
    vi.mocked(useOrganization).mockReturnValue({
      data: undefined,
      isPending: true,
    } as ReturnType<typeof useOrganization>);
    renderPage();

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByText("Online MCP catalog")).not.toBeInTheDocument();
  });
});
