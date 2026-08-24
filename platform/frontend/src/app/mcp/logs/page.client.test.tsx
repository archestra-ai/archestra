import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProfiles } from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useInternalMcpCatalog } from "@/lib/mcp/internal-mcp-catalog.query";
import { useMcpServers } from "@/lib/mcp/mcp-server.query";
import { useMcpToolCalls } from "@/lib/mcp/mcp-tool-call.query";
import McpGatewayLogsPage from "./page.client";

// The cmdk-backed picker reaches for pointer-capture / scrollIntoView /
// ResizeObserver, which jsdom omits.
Element.prototype.scrollIntoView = vi.fn();
Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
Element.prototype.setPointerCapture = vi.fn();
Element.prototype.releasePointerCapture = vi.fn();
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/hooks/use-app-name");

vi.mock("@/lib/agent.query", () => ({ useProfiles: vi.fn() }));
vi.mock("@/lib/mcp/internal-mcp-catalog.query", () => ({
  useInternalMcpCatalog: vi.fn(),
}));
vi.mock("@/lib/mcp/mcp-server.query", () => ({ useMcpServers: vi.fn() }));
vi.mock("@/lib/mcp/mcp-tool-call.query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mcp/mcp-tool-call.query")>()),
  useMcpToolCalls: vi.fn(),
}));

// Two users can each name their own gateway "My Gateway", so the filter has to
// carry enough context to tell them apart.
const personalGateway = {
  id: "g1",
  name: "My Gateway",
  agentType: "mcp_gateway",
  scope: "personal",
  authorEmail: "owner@example.com",
};

const orgGateway = {
  id: "g2",
  name: "Shared Gateway",
  agentType: "mcp_gateway",
  scope: "org",
};

const push = vi.fn();

// role="combobox" takes no accessible name from its contents, so the trigger is
// addressed by the label it renders.
async function openGatewayFilter(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByText("All Agents & MCP Gateways"));
}

describe("McpGatewayLogsPage gateway filter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useRouter).mockReturnValue({
      push,
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
    );
    vi.mocked(usePathname).mockReturnValue("/mcp/logs");
    vi.mocked(useProfiles).mockReturnValue({
      data: [personalGateway, orgGateway],
    } as unknown as ReturnType<typeof useProfiles>);
    vi.mocked(useMcpServers).mockReturnValue({
      data: [],
    } as unknown as ReturnType<typeof useMcpServers>);
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
    } as ReturnType<typeof useHasPermissions>);
    vi.mocked(useInternalMcpCatalog).mockReturnValue({
      data: [],
    } as unknown as ReturnType<typeof useInternalMcpCatalog>);
    vi.mocked(useMcpToolCalls).mockReturnValue({
      data: { data: [], pagination: { total: 0 } },
      isFetching: false,
    } as unknown as ReturnType<typeof useMcpToolCalls>);
  });

  it("shows the owner email of a personal gateway alongside its name", async () => {
    const user = userEvent.setup();
    render(<McpGatewayLogsPage />);

    await openGatewayFilter(user);

    const option = await screen.findByRole("option", { name: /My Gateway/ });
    expect(within(option).getByText("owner@example.com")).toBeVisible();
  });

  it("shows no owner email for a non-personal gateway", async () => {
    const user = userEvent.setup();
    render(<McpGatewayLogsPage />);

    await openGatewayFilter(user);

    const option = await screen.findByRole("option", {
      name: /Shared Gateway/,
    });
    expect(within(option).queryByText("owner@example.com")).toBeNull();
  });

  // A bookmarked filter outlives the gateway it points at; the picker must not
  // claim "All Agents & MCP Gateways" while the table is still filtered.
  it("does not read as unfiltered when the pinned gateway no longer resolves", () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams({
        profileId: "deleted-gateway",
      }) as unknown as ReturnType<typeof useSearchParams>,
    );

    render(<McpGatewayLogsPage />);

    expect(screen.getByText("Filter by Agent")).toBeVisible();
    expect(screen.queryByText("All Agents & MCP Gateways")).toBeNull();
  });

  it("filters tool calls by the picked gateway", async () => {
    const user = userEvent.setup();
    render(<McpGatewayLogsPage />);

    await openGatewayFilter(user);
    await user.click(await screen.findByText("My Gateway"));

    expect(push).toHaveBeenCalledWith(
      expect.stringContaining("profileId=g1"),
      expect.anything(),
    );
    expect(vi.mocked(useMcpToolCalls)).toHaveBeenLastCalledWith(
      expect.objectContaining({ agentId: "g1" }),
    );
  });

  it("presents the call context without separate method, server, and arguments columns", () => {
    vi.mocked(useMcpServers).mockReturnValue({
      data: [
        {
          name: "document-search-deployment",
          catalogName: "Document Search",
          catalogId: "document-search-catalog",
        },
      ],
    } as unknown as ReturnType<typeof useMcpServers>);
    vi.mocked(useInternalMcpCatalog).mockReturnValue({
      data: [
        {
          id: "document-search-catalog",
          name: "Document Search",
          icon: "📚",
        },
      ],
    } as unknown as ReturnType<typeof useInternalMcpCatalog>);
    vi.mocked(useMcpToolCalls).mockReturnValue({
      data: {
        data: [
          {
            id: "call-1",
            ownerType: "agent",
            agentId: orgGateway.id,
            appId: null,
            mcpServerName: "document-search-deployment",
            method: "tools/call",
            toolCall: {
              id: "tool-call-1",
              name: "documents__search_documents",
              arguments: { query: "raw argument only belongs in details" },
            },
            toolResult: { isError: false, content: [] },
            userId: "user-1",
            authMethod: "session",
            createdAt: "2026-08-23T16:30:00.000Z",
            userName: "Demo Admin",
            appName: null,
          },
        ],
        pagination: { total: 1 },
      },
      isFetching: false,
    } as unknown as ReturnType<typeof useMcpToolCalls>);

    render(<McpGatewayLogsPage />);

    for (const header of ["Call", "Gateway", "Identity", "Result", "Time"]) {
      expect(
        screen.getByRole("columnheader", { name: header }),
      ).toBeInTheDocument();
    }
    expect(screen.getByText("search_documents")).toBeVisible();
    expect(screen.getByText("Document Search")).toBeVisible();
    expect(screen.getByText("📚")).toBeInTheDocument();
    expect(screen.getByText("Demo Admin")).toBeVisible();
    expect(screen.getByText("Success")).toBeVisible();
    expect(screen.queryByRole("columnheader", { name: "Method" })).toBeNull();
    expect(
      screen.queryByRole("columnheader", { name: "Arguments" }),
    ).toBeNull();
    expect(screen.queryByText(/raw argument only belongs/)).toBeNull();
  });
});
