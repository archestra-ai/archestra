import {
  ARCHESTRA_MCP_CATALOG_ID,
  archestraApiSdk,
  PLAYWRIGHT_MCP_CATALOG_ID,
} from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@archestra/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@archestra/shared")>();
  return {
    ...actual,
    archestraApiSdk: {
      ...actual.archestraApiSdk,
      assignToolToAgent: vi.fn(),
      unassignToolFromAgent: vi.fn(),
    },
  };
});

vi.mock("@/lib/agent-tools.query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent-tools.query")>()),
  // The agent has none of the server's tools yet.
  useAllProfileTools: () => ({ data: { data: [] } }),
}));

vi.mock("@/lib/mcp/internal-mcp-catalog.query", () => ({
  useCatalogTools: (catalogId: string) => ({
    data: [
      { id: `${catalogId}-tool-1`, name: "tool_one", catalogId },
      { id: `${catalogId}-tool-2`, name: "tool_two", catalogId },
    ],
    isLoading: false,
  }),
}));

vi.mock("@/lib/mcp/mcp-server.query", () => ({
  useMcpServersGroupedByCatalog: () => ({}),
}));

vi.mock("@/lib/mcp/archestra-mcp-server", () => ({
  useArchestraMcpIdentity: () => ({ catalogName: "Archestra" }),
}));

vi.mock("@/components/agent-tools-editor", () => ({
  ToolChecklist: () => null,
}));

vi.mock("@/components/mcp-catalog-icon", () => ({
  McpCatalogIcon: () => null,
}));

vi.mock("sonner");

import { Dialog } from "@/components/ui/dialog";
import { ChooseToolsView } from "./choose-tools-view";

const sdk = vi.mocked(archestraApiSdk);

type Catalog = ComponentProps<typeof ChooseToolsView>["catalog"];

function renderView(catalog: Partial<Catalog>) {
  const onDone = vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      {/* The view lives inside the quick-edit dialog. */}
      <Dialog open>
        <ChooseToolsView
          agentId="agent-1"
          agentName="My Assistant"
          catalog={{ icon: null, ...catalog } as Catalog}
          backLabel="Back"
          onBack={vi.fn()}
          onDone={onDone}
        />
      </Dialog>
    </QueryClientProvider>,
  );
  return { onDone };
}

describe("ChooseToolsView", () => {
  beforeEach(() => {
    sdk.assignToolToAgent.mockResolvedValue({
      data: {},
      error: undefined,
    } as never);
  });

  it("adds Playwright's tools with each person's own connection", async () => {
    const { onDone } = renderView({
      id: PLAYWRIGHT_MCP_CATALOG_ID,
      name: "microsoft__playwright-mcp",
      serverType: "local",
    });

    await userEvent.click(screen.getByRole("button", { name: "Add 2 tools" }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    // A local server's tool is refused without a credential mode.
    for (const toolId of [
      `${PLAYWRIGHT_MCP_CATALOG_ID}-tool-1`,
      `${PLAYWRIGHT_MCP_CATALOG_ID}-tool-2`,
    ]) {
      expect(sdk.assignToolToAgent).toHaveBeenCalledWith({
        path: { agentId: "agent-1", toolId },
        body: { resolveAtCallTime: true, credentialResolutionMode: "dynamic" },
      });
    }
  });

  it("adds Archestra's own tools without a credential", async () => {
    const { onDone } = renderView({
      id: ARCHESTRA_MCP_CATALOG_ID,
      name: "Archestra",
      serverType: "builtin",
    });

    await userEvent.click(screen.getByRole("button", { name: "Add 2 tools" }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(sdk.assignToolToAgent).toHaveBeenCalledWith({
      path: {
        agentId: "agent-1",
        toolId: `${ARCHESTRA_MCP_CATALOG_ID}-tool-1`,
      },
      body: null,
    });
  });
});
