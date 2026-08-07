import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Radix Select uses scrollIntoView and pointer capture
Element.prototype.scrollIntoView = vi.fn();
Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
Element.prototype.setPointerCapture = vi.fn();
Element.prototype.releasePointerCapture = vi.fn();

vi.mock("@/lib/config/config.query");
vi.mock("@/lib/organization.query");

const mockMutate = vi.fn();
vi.mock("@/lib/mcp/internal-mcp-catalog.query", () => ({
  useUpdateInternalMcpCatalogItem: () => ({
    mutate: mockMutate,
    isPending: false,
  }),
}));

const mockUseMcpServers = vi.fn();
vi.mock("@/lib/mcp/mcp-server.query", () => ({
  useMcpServers: () => mockUseMcpServers(),
}));

const mockCanModifyCatalogItem = vi.fn();
vi.mock("./catalog-edit-access", () => ({
  useCanModifyCatalogItem: () => mockCanModifyCatalogItem(),
}));

import { useEnterpriseFeature, useFeature } from "@/lib/config/config.query";
import { useOrganization } from "@/lib/organization.query";
import { makeCatalogItem } from "@/mocks/data/catalog";
import { makeInstalledServer } from "@/mocks/data/servers";
import { IdleHibernationSection } from "./idle-hibernation-section";

const catalogItem = makeCatalogItem({ id: "catalog-1", serverType: "local" });

function setOrgHibernation(mcpIdleHibernationEnabled: boolean) {
  vi.mocked(useOrganization).mockReturnValue({
    data: { mcpIdleHibernationEnabled },
    isPending: false,
  } as ReturnType<typeof useOrganization>);
}

function setInstalledMode(hibernationMode: "inherit" | "enabled" | "disabled") {
  mockUseMcpServers.mockReturnValue({
    data: [
      makeInstalledServer({
        id: "server-1",
        catalogId: "catalog-1",
        hibernationMode,
      }),
    ],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  setOrgHibernation(true);
  setInstalledMode("inherit");
  vi.mocked(useEnterpriseFeature).mockReturnValue(true);
  // The control only exists while the deployment's beta flag is on.
  vi.mocked(useFeature).mockReturnValue(true);
  mockCanModifyCatalogItem.mockReturnValue({
    canModify: true,
    isLoading: false,
  });
});

describe("IdleHibernationSection", () => {
  it("shows the install's current override", () => {
    setInstalledMode("disabled");
    render(<IdleHibernationSection item={catalogItem} />);

    expect(screen.getByRole("combobox")).toHaveTextContent(
      "Never hibernate this server",
    );
  });

  it("defaults to inheriting the organization setting", () => {
    mockUseMcpServers.mockReturnValue({ data: [] });
    render(<IdleHibernationSection item={catalogItem} />);

    expect(screen.getByRole("combobox")).toHaveTextContent(
      "Inherit organization setting",
    );
  });

  it("saves the chosen override through the catalog update", async () => {
    const user = userEvent.setup();
    render(<IdleHibernationSection item={catalogItem} />);

    await user.click(screen.getByRole("combobox"));
    await user.click(
      await screen.findByRole("option", {
        name: "Never hibernate this server",
      }),
    );

    expect(mockMutate).toHaveBeenCalledWith({
      id: "catalog-1",
      data: { hibernationMode: "disabled" },
    });
  });

  it("stays hidden while the organization does not hibernate idle servers", () => {
    setOrgHibernation(false);
    render(<IdleHibernationSection item={catalogItem} />);

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("stays hidden without an active enterprise licence", () => {
    vi.mocked(useEnterpriseFeature).mockReturnValue(false);
    render(<IdleHibernationSection item={catalogItem} />);

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("stays hidden while the deployment's beta flag is off", () => {
    vi.mocked(useFeature).mockReturnValue(false);
    render(<IdleHibernationSection item={catalogItem} />);

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("stays hidden for remote servers, which have no deployment to scale down", () => {
    render(
      <IdleHibernationSection
        item={makeCatalogItem({ id: "catalog-1", serverType: "remote" })}
      />,
    );

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("stays hidden for callers who cannot edit the catalog item", () => {
    mockCanModifyCatalogItem.mockReturnValue({
      canModify: false,
      isLoading: false,
    });
    render(<IdleHibernationSection item={catalogItem} />);

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });
});
