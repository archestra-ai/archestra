import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import type { McpInstallOrchestrator } from "@/lib/mcp/mcp-install-orchestrator.hook";
import { AddToolsView } from "./add-tools-view";

vi.mock("next/navigation");
vi.mock("sonner");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/hooks/use-app-name");

const origin = "http://localhost:9000";
const server = setupServer();
beforeAll(() => {
  archestraApiClient.setConfig({ baseUrl: origin });
  server.listen({ onUnhandledRequest: "error" });
});
beforeEach(() => {
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
  } as ReturnType<typeof useHasPermissions>);
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "user-1" } },
  } as ReturnType<typeof useSession>);
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

it("labels ready servers with the catalog's tool count without a request per server", async () => {
  const catalogToolRequests: string[] = [];
  server.use(
    http.get(`${origin}/api/internal_mcp_catalog`, () =>
      HttpResponse.json([
        catalog({ id: "catalog-ledger", name: "Ledger", toolCount: 4 }),
        catalog({ id: "catalog-empty", name: "Quiet server", toolCount: 0 }),
      ]),
    ),
    http.get(`${origin}/api/internal_mcp_catalog/:id/tools`, ({ params }) => {
      catalogToolRequests.push(String(params.id));
      return HttpResponse.json([]);
    }),
    http.get(`${origin}/api/mcp_server`, () =>
      HttpResponse.json([
        connection("catalog-ledger"),
        connection("catalog-empty"),
      ]),
    ),
    http.get(`${origin}/api/agent-tools`, ({ request }) => {
      expect(new URL(request.url).searchParams.get("includeToolDetails")).toBe(
        "false",
      );
      return HttpResponse.json({
        data: [],
        pagination: {
          total: 0,
          currentPage: 1,
          limit: 1,
          totalPages: 0,
          hasNext: false,
          hasPrev: false,
        },
      });
    }),
  );

  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <Dialog open>
        <DialogContent>
          <AddToolsView
            agentId="agent-1"
            agentName="Helper"
            installer={{} as McpInstallOrchestrator}
            onBack={vi.fn()}
            onChooseTools={vi.fn()}
            onConnect={vi.fn()}
            onAdded={vi.fn()}
            onFailed={vi.fn()}
          />
        </DialogContent>
      </Dialog>
    </QueryClientProvider>,
  );

  expect(await screen.findByText(/4 tools/)).toBeInTheDocument();
  expect(
    screen.getByText("Connected, but the server reports no tools"),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Add all" })).toBeEnabled();
  expect(catalogToolRequests).toEqual([]);
});

function catalog(params: { id: string; name: string; toolCount: number }) {
  return {
    ...params,
    description: null,
    serverType: "remote",
    oauthConfig: null,
    icon: null,
  };
}

function connection(catalogId: string) {
  return {
    id: `server-${catalogId}`,
    name: catalogId,
    catalogId,
    ownerId: "user-1",
    scope: "org",
    localInstallationStatus: "success",
  };
}
