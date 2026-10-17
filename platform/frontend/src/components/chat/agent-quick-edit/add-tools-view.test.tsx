import { ARCHESTRA_MCP_CATALOG_ID } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { registryRows, sentRequests } = vi.hoisted(() => ({
  registryRows: [] as Array<Record<string, unknown>>,
  // Each distinct request a mounted query would send (disabled ones send none).
  sentRequests: new Set<string>(),
}));

vi.mock("@/lib/agent-tools.query", () => ({
  ServerToolsUpdateError: class extends Error {},
  useAllProfileTools: () => ({ data: { data: [] } }),
  useUpdateAgentServerTools: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("@/lib/mcp/archestra-mcp-server", () => ({
  useArchestraMcpIdentity: () => ({ catalogName: "Archestra" }),
}));

vi.mock("@/lib/mcp/mcp-server.query", () => ({
  useMcpServers: () => ({ data: [] }),
  useMcpServersGroupedByCatalog: () => ({}),
}));

vi.mock("@/components/mcp-catalog-icon", () => ({
  McpCatalogIcon: () => null,
}));

// The registry search as the server answers it: the built-in entry only with
// `includeBuiltIn`, and "installed" meaning an install the viewer can use
// (which the built-in entry never has).
vi.mock("@/lib/mcp/mcp-registry.query", () => ({
  useMcpRegistryPage: (
    params: {
      includeBuiltIn?: boolean;
      installState?: "installed" | "not-installed";
      catalogIds?: string[];
      search?: string;
      limit?: number;
    },
    options?: { enabled?: boolean },
  ) => {
    if (options?.enabled === false) return { data: undefined, isPending: true };
    sentRequests.add(JSON.stringify(params));
    const rows = registryRows.filter(
      (row) =>
        (params.includeBuiltIn || row.id !== ARCHESTRA_MCP_CATALOG_ID) &&
        (!params.catalogIds || params.catalogIds.includes(row.id as string)) &&
        (!params.search ||
          (row.name as string)
            .toLowerCase()
            .includes(params.search.toLowerCase())) &&
        (params.installState === undefined ||
          (params.installState === "installed") ===
            (row.install as { installedForViewer: boolean })
              .installedForViewer),
    );
    return {
      data: {
        data: rows.slice(0, params.limit ?? rows.length),
        pagination: { total: rows.length },
        installs: [],
      },
      isPending: false,
    };
  },
  fetchInternalMcpCatalogItem: vi.fn(),
}));

import { Dialog } from "@/components/ui/dialog";
import { AddToolsView } from "./add-tools-view";

function row(
  id: string,
  name: string,
  install: { visibleCount: number; installedForViewer: boolean },
  serverType = "remote",
) {
  return {
    id,
    name,
    description: null,
    icon: null,
    iconUrl: null,
    serverType,
    toolCount: 2,
    setupNeeds: { signIn: false, settings: 0 },
    install: { ...install, primaryServerId: null },
  };
}

function renderView() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      {/* The view lives inside the quick-edit dialog. */}
      <Dialog open>
        <AddToolsView
          agentId="agent-1"
          agentName="Agent"
          // biome-ignore lint/suspicious/noExplicitAny: the view only passes it on
          installer={{} as any}
          onBack={vi.fn()}
          onChooseTools={vi.fn()}
          onConnect={vi.fn()}
          onAdded={vi.fn()}
          onFailed={vi.fn()}
        />
      </Dialog>
    </QueryClientProvider>,
  );
}

function group(title: string) {
  const heading = screen.queryByRole("heading", { name: title });
  if (!heading) return [];
  const section = heading.closest("section") as HTMLElement;
  return within(section)
    .getAllByRole("listitem")
    .map((item) => item.textContent ?? "");
}

const names = (items: string[]) =>
  ["Archestra", "Jira", "Notion", "Slack"].filter((name) =>
    items.some((text) => text.includes(name)),
  );

describe("AddToolsView", () => {
  beforeEach(() => {
    sentRequests.clear();
    registryRows.length = 0;
    registryRows.push(
      row(
        ARCHESTRA_MCP_CATALOG_ID,
        "Archestra",
        { visibleCount: 0, installedForViewer: false },
        "builtin",
      ),
      row("jira", "Jira", { visibleCount: 1, installedForViewer: true }),
      // Only someone else's personal install: visible, but not usable.
      row("notion", "Notion", { visibleCount: 1, installedForViewer: false }),
      row("slack", "Slack", { visibleCount: 0, installedForViewer: false }),
    );
  });

  it("calls a server connected only when the viewer can use an install, on every tab", async () => {
    const user = userEvent.setup();
    renderView();

    expect(screen.getByRole("button", { name: "All 4" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Connected 2" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Not connected 2" }),
    ).toBeInTheDocument();
    expect(names(group("Ready to add"))).toEqual(["Archestra", "Jira"]);
    expect(names(group("Connect first"))).toEqual(["Notion", "Slack"]);

    await user.click(screen.getByRole("button", { name: /^Connected/ }));
    expect(names(group("Ready to add"))).toEqual(["Archestra", "Jira"]);
    expect(group("Connect first")).toEqual([]);
    expect(
      screen.getByRole("button", { name: "Connected 2" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Not connected/ }));
    expect(group("Ready to add")).toEqual([]);
    expect(names(group("Connect first"))).toEqual(["Notion", "Slack"]);
  });

  it("asks the registry three things per search: the page, the other tab's total, the built-in entry", async () => {
    const user = userEvent.setup();
    renderView();

    await user.type(screen.getByLabelText("Search servers"), "jira");
    await screen.findByRole("button", { name: "All 1" });

    const forSearch = [...sentRequests]
      .map((request) => JSON.parse(request) as { search?: string })
      .filter((request) => request.search === "jira");
    expect(forSearch).toHaveLength(3);
  });

  it("counts the built-in entry only while the search matches it", async () => {
    const user = userEvent.setup();
    renderView();

    await user.type(screen.getByLabelText("Search servers"), "jira");

    expect(
      await screen.findByRole("button", { name: "All 1" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Connected 1" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Not connected 0" }),
    ).toBeInTheDocument();
  });
});
