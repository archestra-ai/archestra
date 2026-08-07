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
vi.mock("@/lib/config/config.query");

import {
  useHasPermissions,
  useMissingPermissions,
} from "@/lib/auth/auth.query";
import {
  useEnterpriseFeature,
  useFeature,
  useSmallTeamTier,
} from "@/lib/config/config.query";
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
    mcpIdleHibernationEnabled: boolean;
  }> = {},
) {
  vi.mocked(useOrganization).mockReturnValue({
    data: {
      onlineMcpCatalogEnabled: true,
      mcpIdleHibernationEnabled: false,
      ...settings,
    },
    isPending: false,
  } as ReturnType<typeof useOrganization>);
}

beforeEach(() => {
  vi.clearAllMocks();
  setPermission(true);
  setOrganization();
  vi.mocked(useEnterpriseFeature).mockReturnValue(true);
  // The hibernation block only exists when the beta flag is on.
  vi.mocked(useFeature).mockReturnValue(true);
  vi.mocked(useSmallTeamTier).mockReturnValue(
    undefined as ReturnType<typeof useSmallTeamTier>,
  );
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
  const card = screen.getByText(title).closest('[data-slot="card"]');
  if (!card) throw new Error(`No settings block titled "${title}"`);
  return within(card as HTMLElement).getByRole("combobox");
}

describe("McpSettingsPage", () => {
  it("renders the online catalog setting", () => {
    renderPage();

    expect(screen.getByText("Online MCP catalog")).toBeInTheDocument();
    expect(blockSelect("Online MCP catalog")).toHaveTextContent("Enabled");
  });

  it("renders the idle hibernation setting alongside the catalog setting", () => {
    setOrganization({ mcpIdleHibernationEnabled: true });
    renderPage();

    expect(screen.getByText("Idle hibernation")).toBeInTheDocument();
    expect(blockSelect("Idle hibernation")).toHaveTextContent("Enabled");
  });

  it("reflects a disabled online catalog from the organization", () => {
    setOrganization({ onlineMcpCatalogEnabled: false });
    renderPage();

    expect(blockSelect("Online MCP catalog")).toHaveTextContent("Disabled");
  });

  it("disables the control when the user cannot update MCP settings", () => {
    setPermission(false);
    renderPage();

    expect(blockSelect("Online MCP catalog")).toBeDisabled();
  });

  it("makes hibernation inert without an enterprise licence, leaving the catalog editable", () => {
    vi.mocked(useEnterpriseFeature).mockReturnValue(false);
    renderPage();

    expect(blockSelect("Idle hibernation")).toBeDisabled();
    expect(blockSelect("Online MCP catalog")).toBeEnabled();
  });

  it("hides hibernation entirely while the beta flag is off", () => {
    vi.mocked(useFeature).mockReturnValue(false);
    renderPage();

    expect(screen.queryByText("Idle hibernation")).not.toBeInTheDocument();
    expect(blockSelect("Online MCP catalog")).toBeEnabled();
  });

  it("enables the hibernation control once enterprise core is active", () => {
    renderPage();

    expect(blockSelect("Idle hibernation")).toBeEnabled();
  });

  it("saves only the settings the user changed", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(blockSelect("Idle hibernation"));
    await user.click(await screen.findByRole("option", { name: "Enabled" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(mockMutateAsync).toHaveBeenCalledWith({
      mcpIdleHibernationEnabled: true,
    });
  });

  it("saves both settings when both changed", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(blockSelect("Online MCP catalog"));
    await user.click(await screen.findByRole("option", { name: "Disabled" }));
    await user.click(blockSelect("Idle hibernation"));
    await user.click(await screen.findByRole("option", { name: "Enabled" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(mockMutateAsync).toHaveBeenCalledWith({
      onlineMcpCatalogEnabled: false,
      mcpIdleHibernationEnabled: true,
    });
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
