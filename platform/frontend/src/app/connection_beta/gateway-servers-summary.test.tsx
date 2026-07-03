import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProfile } from "@/lib/agent.query";
import { useCanManageGateway } from "@/lib/auth/use-can-manage-gateway";
import { useInternalMcpCatalog } from "@/lib/mcp/internal-mcp-catalog.query";
import { GatewayServersSummary } from "./gateway-servers-summary";

vi.mock("@/lib/agent.query", () => ({ useProfile: vi.fn() }));
vi.mock("@/lib/mcp/internal-mcp-catalog.query", () => ({
  useInternalMcpCatalog: vi.fn(),
}));
vi.mock("@/lib/auth/use-can-manage-gateway", () => ({
  useCanManageGateway: vi.fn(),
}));
// next/image + app-logo plumbing is irrelevant to the grouping/link behavior
vi.mock("@/components/mcp-catalog-icon", () => ({
  McpCatalogIcon: () => null,
}));

type Tool = { name: string; catalogId: string | null };

function mockGateway(tools: Tool[], extra: { accessAllTools?: boolean } = {}) {
  vi.mocked(useProfile).mockReturnValue({
    data: { id: "g1", tools, accessAllTools: false, ...extra },
  } as unknown as ReturnType<typeof useProfile>);
}

function mockCatalog(
  items: {
    id: string;
    name: string;
    description?: string;
    toolCount?: number;
  }[],
) {
  vi.mocked(useInternalMcpCatalog).mockReturnValue({
    data: items.map((i) => ({
      icon: null,
      description: null,
      toolCount: 0,
      ...i,
    })),
  } as unknown as ReturnType<typeof useInternalMcpCatalog>);
}

/** The list is collapsed by default; unfold it to inspect the rows. */
async function expandList() {
  await userEvent.setup().click(screen.getByRole("button"));
}

describe("GatewayServersSummary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCatalog([]);
    vi.mocked(useCanManageGateway).mockReturnValue({
      canManage: false,
      isLoading: false,
    });
  });

  it("is collapsed by default and only shows the summary line", () => {
    mockGateway([{ name: "github__create_issue", catalogId: "c-github" }]);
    mockCatalog([{ id: "c-github", name: "GitHub" }]);

    render(<GatewayServersSummary gatewayId="g1" />);

    // summary is visible…
    expect(screen.getByText(/1 MCP server/)).toBeInTheDocument();
    // …but the per-server list stays folded until asked for
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });

  it("groups the gateway's tools per MCP server with counts, descriptions, and detail links", async () => {
    mockGateway([
      { name: "github__create_issue", catalogId: "c-github" },
      { name: "github__list_prs", catalogId: "c-github" },
      { name: "slack__post_message", catalogId: "c-slack" },
    ]);
    mockCatalog([
      { id: "c-github", name: "GitHub", description: "Issues and PRs" },
      { id: "c-slack", name: "Slack", description: "Post messages" },
    ]);

    render(<GatewayServersSummary gatewayId="g1" />);

    // header count: 2 servers, 3 tools total
    expect(screen.getByText(/2 MCP servers/)).toBeInTheDocument();
    expect(screen.getByText(/3 tools/)).toBeInTheDocument();

    await expandList();

    const items = screen.getAllByRole("listitem");
    // sorted by tool count, largest first
    expect(items[0]).toHaveTextContent("GitHub");
    expect(items[0]).toHaveTextContent("2 tools");
    expect(items[0]).toHaveTextContent("Issues and PRs");
    expect(items[1]).toHaveTextContent("Slack");
    expect(items[1]).toHaveTextContent("1 tool");

    // each server links to its catalog detail page, in the same tab
    const githubLink = screen.getByRole("link", { name: /GitHub/ });
    expect(githubLink).toHaveAttribute("href", "/mcp/registry/beta/c-github");
    expect(githubLink).not.toHaveAttribute("target");
  });

  it("derives a server name from the tool prefix (and no link) when the catalog has no entry", async () => {
    mockGateway([{ name: "linear__create_ticket", catalogId: null }]);

    render(<GatewayServersSummary gatewayId="g1" />);
    await expandList();

    const item = screen.getByRole("listitem");
    expect(item).toHaveTextContent("Linear");
    // catalog-less servers have no detail page → not a link
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("says so when the gateway exposes no servers", () => {
    mockGateway([]);

    render(<GatewayServersSummary gatewayId="g1" />);

    expect(
      screen.getByText(/doesn't expose any MCP servers yet/),
    ).toBeInTheDocument();
  });

  it("lists the org catalog for 'access all tools' gateways, labeled as dynamic", async () => {
    // accessAllTools gateways have an empty profile tool list but expose the
    // whole org catalog — enumerate that instead of a vague sentence.
    mockGateway([], { accessAllTools: true });
    mockCatalog([
      { id: "c-github", name: "GitHub", toolCount: 91 },
      { id: "c-slack", name: "Slack", toolCount: 28 },
    ]);

    render(<GatewayServersSummary gatewayId="g1" />);

    expect(screen.getByText(/All 2 MCP servers/)).toBeInTheDocument();
    expect(
      screen.getByText(/new servers included automatically/),
    ).toBeInTheDocument();

    await expandList();
    // catalog tool counts are used (91), and rows link to detail pages
    expect(screen.getByText(/91 tools/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /GitHub/ })).toHaveAttribute(
      "href",
      "/mcp/registry/beta/c-github",
    );
  });

  it("falls back to an honest headline for an access-all gateway with an empty catalog", () => {
    mockGateway([], { accessAllTools: true });
    mockCatalog([]);

    render(<GatewayServersSummary gatewayId="g1" />);

    expect(
      screen.getByText(/Exposes every tool in your organization/),
    ).toBeInTheDocument();
  });

  it("renders nothing while the gateway is still loading", () => {
    vi.mocked(useProfile).mockReturnValue({
      data: undefined,
    } as unknown as ReturnType<typeof useProfile>);

    const { container } = render(<GatewayServersSummary gatewayId="g1" />);

    expect(container).toBeEmptyDOMElement();
  });

  it("unfolds the list when the header toggle is clicked", async () => {
    mockGateway([{ name: "github__create_issue", catalogId: "c-github" }]);
    mockCatalog([{ id: "c-github", name: "GitHub" }]);

    render(<GatewayServersSummary gatewayId="g1" />);
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();

    await expandList();
    expect(screen.getByRole("listitem")).toBeInTheDocument();
  });

  it("shows an Edit-on-gateway link only when the user can manage the gateway", () => {
    mockGateway([{ name: "github__create_issue", catalogId: "c-github" }]);
    mockCatalog([{ id: "c-github", name: "GitHub" }]);

    const { rerender } = render(<GatewayServersSummary gatewayId="g1" />);
    expect(
      screen.queryByRole("link", { name: /Edit on gateway/ }),
    ).not.toBeInTheDocument();

    vi.mocked(useCanManageGateway).mockReturnValue({
      canManage: true,
      isLoading: false,
    });
    rerender(<GatewayServersSummary gatewayId="g1" />);
    // just opens the edit form (no forced tool picker), in the same tab
    const link = screen.getByRole("link", { name: /Edit on gateway/ });
    expect(link).toHaveAttribute("href", "/mcp/gateways?edit=g1");
    expect(link).not.toHaveAttribute("target");
  });
});
