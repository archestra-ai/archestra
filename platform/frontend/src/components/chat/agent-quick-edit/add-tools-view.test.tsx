import { ARCHESTRA_MCP_CATALOG_ID } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { registryRows, sentRequests, stillLoading } = vi.hoisted(() => ({
  registryRows: [] as Array<Record<string, unknown>>,
  // Requests that have not answered yet (and have nothing to show meanwhile).
  stillLoading: {
    test: (_params: Record<string, unknown>): boolean => false,
    // Like the real hook: a loading query shows its scope's last answer.
    keepsPrevious: false,
    previous: new Map<string, unknown>(),
  },
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
    options?: { enabled?: boolean; placeholderScope?: string },
  ) => {
    if (options?.enabled === false) return { data: undefined, isPending: true };
    sentRequests.add(JSON.stringify(params));
    if (stillLoading.test(params)) {
      const previous = stillLoading.keepsPrevious
        ? stillLoading.previous.get(options?.placeholderScope ?? "")
        : undefined;
      return previous
        ? { data: previous, isPending: false, isPlaceholderData: true }
        : { data: undefined, isPending: true };
    }
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
    const data = {
      data: rows.slice(0, params.limit ?? rows.length),
      pagination: { total: rows.length },
      installs: [],
    };
    stillLoading.previous.set(options?.placeholderScope ?? "", data);
    return { data, isPending: false, isPlaceholderData: false };
  },
  fetchInternalMcpCatalogItem: vi.fn(),
}));

import { Dialog } from "@/components/ui/dialog";
import { fetchInternalMcpCatalogItem } from "@/lib/mcp/mcp-registry.query";
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

function renderView(handlers: { onChooseTools?: () => void } = {}) {
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
          onChooseTools={handlers.onChooseTools ?? vi.fn()}
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
    stillLoading.test = () => false;
    stillLoading.keepsPrevious = false;
    stillLoading.previous.clear();
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

  it("asks the registry four things per search: the page, both totals, the built-in entry", async () => {
    const user = userEvent.setup();
    renderView();

    await user.type(screen.getByLabelText("Search servers"), "jira");
    await screen.findByRole("button", { name: "All 1" });

    const forSearch = [...sentRequests]
      .map((request) => JSON.parse(request) as { search?: string })
      .filter((request) => request.search === "jira");
    expect(forSearch).toHaveLength(4);
  });

  it("keeps every tab's count while a tab's page loads", async () => {
    const user = userEvent.setup();
    renderView();
    const labels = () =>
      ["All", "Connected", "Not connected"].map(
        (name) =>
          screen.getByRole("button", { name: new RegExp(`^${name}`) })
            .textContent,
      );
    const settled = ["All 4", "Connected 2", "Not connected 2"];
    expect(labels()).toEqual(settled);

    // A tab's page (a full page, not a count) has not answered yet.
    stillLoading.test = (params) => params.limit !== 1;
    await user.click(screen.getByRole("button", { name: /^Connected/ }));
    expect(labels()).toEqual(settled);
    await user.click(screen.getByRole("button", { name: /^Not connected/ }));
    expect(labels()).toEqual(settled);

    // Nothing has answered for a new search: the last counts stay, and no
    // count is made up from the visible rows meanwhile.
    stillLoading.test = (params) => params.search === "jira";
    await user.type(screen.getByLabelText("Search servers"), "jira");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(labels()).toEqual(settled);
  });

  it("never mixes the counts of two searches", async () => {
    const user = userEvent.setup();
    renderView();
    const labels = () =>
      ["All", "Connected", "Not connected"].map(
        (name) =>
          screen.getByRole("button", { name: new RegExp(`^${name}`) })
            .textContent,
      );
    expect(labels()).toEqual(["All 4", "Connected 2", "Not connected 2"]);

    // The new search's built-in probe answers (no built-in entry matches
    // "jira") before its totals, which still show the last search's.
    stillLoading.keepsPrevious = true;
    stillLoading.test = (params) =>
      params.search === "jira" && params.limit === 1 && !params.catalogIds;
    await user.type(screen.getByLabelText("Search servers"), "jira");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(labels()).toEqual(["All 4", "Connected 2", "Not connected 2"]);

    stillLoading.test = () => false;
    await user.type(screen.getByLabelText("Search servers"), " ");
    await user.keyboard("{Backspace}");
    expect(
      await screen.findByRole("button", { name: "Connected 1" }),
    ).toBeInTheDocument();
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

  it("holds a row's actions while its server loads for the clicked one", async () => {
    const user = userEvent.setup();
    let answer: (item: unknown) => void = () => {};
    vi.mocked(fetchInternalMcpCatalogItem).mockReturnValue(
      new Promise((resolve) => {
        answer = resolve as (item: unknown) => void;
      }) as never,
    );
    const onChooseTools = vi.fn();
    renderView({ onChooseTools });
    const jira = within(
      (await screen.findByText("Jira")).closest("li") as HTMLElement,
    );

    await user.click(jira.getByRole("button", { name: "Choose tools" }));

    expect(jira.getByRole("button", { name: "Choose tools" })).toBeDisabled();
    expect(jira.getByRole("button", { name: "Add all" })).toBeDisabled();
    expect(onChooseTools).not.toHaveBeenCalled();

    answer({ id: "jira", name: "Jira" });

    await vi.waitFor(() =>
      expect(onChooseTools).toHaveBeenCalledWith(
        expect.objectContaining({ id: "jira" }),
      ),
    );
    expect(jira.getByRole("button", { name: "Add all" })).toBeEnabled();
  });
});
