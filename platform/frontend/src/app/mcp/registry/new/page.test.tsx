import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation");
vi.mock("@/lib/organization.query");
vi.mock("@/lib/mcp/internal-mcp-catalog.query");

vi.mock("../_parts/catalog-setup-wizard", () => ({
  SetupStepper: () => <div data-testid="setup-stepper" />,
}));
vi.mock("../_parts/archestra-catalog-tab", () => ({
  ArchestraCatalogTab: () => <div data-testid="catalog-browser" />,
}));
vi.mock("../_parts/mcp-catalog-form", () => ({
  McpCatalogForm: ({
    footer,
  }: {
    footer: (state: { hasBlockingErrors: boolean }) => React.ReactNode;
  }) => (
    <div data-testid="mcp-catalog-form">
      {footer({ hasBlockingErrors: false })}
    </div>
  ),
}));

import { useSearchParams } from "next/navigation";
import {
  useCreateInternalMcpCatalogItem,
  useInternalMcpCatalog,
} from "@/lib/mcp/internal-mcp-catalog.query";
import { useOrganization } from "@/lib/organization.query";
import NewMcpCatalogItemPage from "./page";

function mockOrganization(onlineMcpCatalogEnabled: boolean, isPending = false) {
  vi.mocked(useOrganization).mockReturnValue({
    data: isPending ? undefined : { onlineMcpCatalogEnabled },
    isPending,
  } as ReturnType<typeof useOrganization>);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams() as ReturnType<typeof useSearchParams>,
  );
  vi.mocked(useInternalMcpCatalog).mockReturnValue({
    data: [],
  } as unknown as ReturnType<typeof useInternalMcpCatalog>);
  vi.mocked(useCreateInternalMcpCatalogItem).mockReturnValue({
    mutateAsync: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof useCreateInternalMcpCatalogItem>);
});

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <NewMcpCatalogItemPage />
    </QueryClientProvider>,
  );
}

describe("NewMcpCatalogItemPage", () => {
  it("shows the source chooser when the online catalog is enabled", () => {
    mockOrganization(true);
    renderPage();

    expect(screen.getByText("Start from scratch")).toBeInTheDocument();
    expect(screen.getByText("Select from Online Catalog")).toBeInTheDocument();
    expect(screen.queryByTestId("mcp-catalog-form")).not.toBeInTheDocument();
  });

  it("skips the chooser and opens the form directly when the online catalog is disabled", () => {
    mockOrganization(false);
    renderPage();

    expect(screen.queryByText("Start from scratch")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Select from Online Catalog"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("mcp-catalog-form")).toBeInTheDocument();
  });

  it("shows Cancel (not Back) in the footer when the catalog is disabled", () => {
    mockOrganization(false);
    renderPage();

    expect(screen.getByRole("link", { name: "Cancel" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /back/i }),
    ).not.toBeInTheDocument();
  });

  it("renders a loading state until the catalog setting resolves", () => {
    mockOrganization(true, true);
    renderPage();

    expect(screen.queryByText("Start from scratch")).not.toBeInTheDocument();
    expect(screen.queryByTestId("mcp-catalog-form")).not.toBeInTheDocument();
  });

  it("fails closed — hides the chooser when the org read resolves without data", () => {
    vi.mocked(useOrganization).mockReturnValue({
      data: undefined,
      isPending: false,
    } as ReturnType<typeof useOrganization>);
    renderPage();

    expect(screen.queryByText("Start from scratch")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Select from Online Catalog"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("mcp-catalog-form")).toBeInTheDocument();
  });
});
