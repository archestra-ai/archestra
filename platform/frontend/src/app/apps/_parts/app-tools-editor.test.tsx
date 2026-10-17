import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Radix Popover/Checkbox measure layout and use pointer capture, which jsdom
// doesn't implement.
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = vi.fn();
Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
Element.prototype.setPointerCapture = vi.fn();
Element.prototype.releasePointerCapture = vi.fn();

// The "+ Add" combobox is a Radix dropdown on floating-ui, which needs a real
// ResizeObserver, layout rects, and DOMRect to position.
Element.prototype.getBoundingClientRect =
  Element.prototype.getBoundingClientRect ??
  (() =>
    ({
      x: 0,
      y: 0,
      width: 100,
      height: 20,
      top: 0,
      right: 100,
      bottom: 20,
      left: 0,
      toJSON: () => {},
    }) as DOMRect);
if (typeof globalThis.DOMRect === "undefined") {
  globalThis.DOMRect = class DOMRect {
    x = 0;
    y = 0;
    width = 0;
    height = 0;
    top = 0;
    right = 0;
    bottom = 0;
    left = 0;
    toJSON() {}
    static fromRect() {
      return new DOMRect();
    }
  } as unknown as typeof globalThis.DOMRect;
}

const {
  assignMutate,
  unassignMutate,
  useAppMock,
  useAppToolsMock,
  useInternalMcpCatalogMock,
  fetchCatalogToolsMock,
  registryPageCalls,
} = vi.hoisted(() => ({
  assignMutate: vi.fn(),
  unassignMutate: vi.fn(),
  useAppMock: vi.fn(),
  useAppToolsMock: vi.fn(),
  useInternalMcpCatalogMock: vi.fn(),
  fetchCatalogToolsMock: vi.fn(),
  registryPageCalls: [] as unknown[],
}));

vi.mock("@/lib/app.query", () => ({
  useApp: useAppMock,
  useAppTools: useAppToolsMock,
  useAssignToolToApp: () => ({ mutate: assignMutate }),
  useUnassignToolFromApp: () => ({ mutate: unassignMutate }),
}));

vi.mock("@/lib/auth/auth.query");

vi.mock("@/lib/mcp/internal-mcp-catalog.query", () => ({
  useMcpCatalogCredentialPreflight: () => ({ data: [] }),
  fetchCatalogTools: fetchCatalogToolsMock,
}));

// The registry reads, answered from the catalog rows each test sets: the
// app's servers by id, and the Add list's page.
vi.mock("@/lib/mcp/use-mcp-registry-rows-by-ids", () => ({
  useMcpRegistryRowsByIds: (ids: string[]) => ({
    data: (useInternalMcpCatalogMock().data as Array<{ id: string }>).filter(
      (row) => ids.includes(row.id),
    ),
    isPending: false,
    hasLoaded: true,
    isError: false,
  }),
}));
vi.mock("@/lib/mcp/mcp-registry.query", () => ({
  // Like the server: the search narrows by name, the page is sorted by name
  // and cut to the limit.
  useMcpRegistryPage: (params: { search?: string; limit?: number }) => {
    registryPageCalls.push(params);
    const all = useInternalMcpCatalogMock().data as Array<{ name: string }>;
    const matching = all
      .filter(
        (row) =>
          !params.search ||
          row.name.toLowerCase().includes(params.search.toLowerCase()),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      data: {
        data: matching.slice(0, params.limit ?? matching.length),
        pagination: { total: matching.length },
      },
      isPending: false,
      isFetching: false,
    };
  },
}));

// The catalog icon pulls in white-label app-name hooks the bare render lacks.
vi.mock("@/components/mcp-catalog-icon", () => ({
  McpCatalogIcon: () => null,
}));

import { useHasPermissions } from "@/lib/auth/auth.query";
import { AppToolsEditor } from "./app-tools-editor";

const APP_ID = "app-1";
const JIRA_CATALOG_ID = "jira-catalog";

function makeCatalog(over: Record<string, unknown> = {}) {
  return {
    id: JIRA_CATALOG_ID,
    name: "JIRA",
    icon: null,
    iconUrl: null,
    toolCount: 2,
    serverType: "local",
    environmentId: null,
    ...over,
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
  } as any;
}

function makeTool(id: string, name: string) {
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { id, name, description: null, catalogId: JIRA_CATALOG_ID } as any;
}

function renderTab() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AppToolsEditor appId={APP_ID} />
    </QueryClientProvider>,
  );
}

const controlledClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
function controlledEditor(
  selected: Set<string>,
  onSelectionChange: (next: Set<string>) => void,
) {
  return (
    <QueryClientProvider client={controlledClient}>
      <AppToolsEditor
        appId={APP_ID}
        selectedToolIds={selected}
        onSelectionChange={onSelectionChange}
      />
    </QueryClientProvider>
  );
}

// The staged host (the app settings form) drives selection as a controlled
// Set; toggles report up via onSelectionChange instead of persisting live.
function renderControlled(onSelectionChange: (next: Set<string>) => void) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AppToolsEditor
        appId={APP_ID}
        selectedToolIds={new Set(["t-create"])}
        onSelectionChange={onSelectionChange}
      />
    </QueryClientProvider>,
  );
}

describe("AppToolsEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registryPageCalls.length = 0;
    useAppMock.mockReturnValue({ data: { environmentId: null } });
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
    } as ReturnType<typeof useHasPermissions>);
    useInternalMcpCatalogMock.mockReturnValue({ data: [makeCatalog()] });
    // create_issue is already assigned; delete_issue is available but not.
    useAppToolsMock.mockReturnValue({
      data: [makeTool("t-create", "create_issue")],
      isPending: false,
    });
    fetchCatalogToolsMock.mockResolvedValue([
      makeTool("t-create", "create_issue"),
      makeTool("t-delete", "delete_issue"),
    ]);
  });

  it("groups an app's tools under their MCP server and reflects the assigned set", async () => {
    const user = userEvent.setup();
    renderTab();

    // The server renders as a pill showing its selected-tool count.
    const pill = await screen.findByRole("button", { name: /JIRA/ });
    expect(pill).toHaveTextContent("(1)");

    // Open the pill; tools load into the popover and the assigned one is checked.
    await user.click(pill);
    const created = await screen.findByLabelText("create_issue");
    const deleted = await screen.findByLabelText("delete_issue");
    expect(created).toBeChecked();
    expect(deleted).not.toBeChecked();
  });

  it("assigns a tool with dynamic credentials when checked", async () => {
    const user = userEvent.setup();
    renderTab();

    await user.click(await screen.findByRole("button", { name: /JIRA/ }));
    await user.click(await screen.findByLabelText("delete_issue"));

    expect(assignMutate).toHaveBeenCalledWith({
      appId: APP_ID,
      toolId: "t-delete",
      body: { credentialResolutionMode: "dynamic" },
    });
    expect(unassignMutate).not.toHaveBeenCalled();
  });

  it("unassigns a tool when unchecked", async () => {
    const user = userEvent.setup();
    renderTab();

    await user.click(await screen.findByRole("button", { name: /JIRA/ }));
    await user.click(await screen.findByLabelText("create_issue"));

    expect(unassignMutate).toHaveBeenCalledWith({
      appId: APP_ID,
      toolId: "t-create",
    });
    expect(assignMutate).not.toHaveBeenCalled();
  });

  it("adds a server from the '+ Add' menu without live-assigning its tools", async () => {
    const user = userEvent.setup();
    const NOTION_ID = "notion-catalog";
    useInternalMcpCatalogMock.mockReturnValue({
      data: [makeCatalog(), makeCatalog({ id: NOTION_ID, name: "Notion" })],
    });
    fetchCatalogToolsMock.mockImplementation((id: string) =>
      Promise.resolve(
        id === NOTION_ID
          ? [
              {
                id: "n-page",
                name: "create_page",
                description: null,
                catalogId: NOTION_ID,
              },
            ]
          : [makeTool("t-create", "create_issue")],
      ),
    );
    renderTab();

    await screen.findByRole("button", { name: /JIRA/ });
    await user.click(screen.getByRole("button", { name: /add/i }));
    // findBy waits out the "no tools" disabled state until Notion's tools load.
    await user.click(
      await screen.findByRole("menuitemcheckbox", { name: /notion/i }),
    );

    // The added server's popover pops open showing its tool unselected, and the
    // live editor fired no assignment — the user picks tools deliberately.
    expect(await screen.findByLabelText("create_page")).not.toBeChecked();
    expect(assignMutate).not.toHaveBeenCalled();
  });

  it("stages every tool of a server added in the settings form, persisting nothing", async () => {
    const user = userEvent.setup();
    const NOTION_ID = "notion-catalog";
    useInternalMcpCatalogMock.mockReturnValue({
      data: [makeCatalog(), makeCatalog({ id: NOTION_ID, name: "Notion" })],
    });
    fetchCatalogToolsMock.mockImplementation((id: string) =>
      Promise.resolve(
        id === NOTION_ID
          ? [
              {
                id: "n-page",
                name: "create_page",
                description: null,
                catalogId: NOTION_ID,
              },
              {
                id: "n-db",
                name: "query_db",
                description: null,
                catalogId: NOTION_ID,
              },
            ]
          : [makeTool("t-create", "create_issue")],
      ),
    );
    const onSelectionChange = vi.fn();
    renderControlled(onSelectionChange);

    await screen.findByRole("button", { name: /JIRA/ });
    await user.click(screen.getByRole("button", { name: /add/i }));
    await user.click(
      await screen.findByRole("menuitemcheckbox", { name: /notion/i }),
    );

    // Staged mode merges every tool of the added server into the selection and
    // fires no live mutation — the opposite of the uncontrolled host above.
    expect(onSelectionChange).toHaveBeenLastCalledWith(
      new Set(["t-create", "n-page", "n-db"]),
    );
    expect(assignMutate).not.toHaveBeenCalled();
    expect(unassignMutate).not.toHaveBeenCalled();
  });

  it("keeps a selection change made while an added server's tools load", async () => {
    const user = userEvent.setup();
    const NOTION_ID = "notion-catalog";
    useInternalMcpCatalogMock.mockReturnValue({
      data: [makeCatalog(), makeCatalog({ id: NOTION_ID, name: "Notion" })],
    });
    let releaseNotion: (tools: unknown[]) => void = () => {};
    fetchCatalogToolsMock.mockImplementation((id: string) =>
      id === NOTION_ID
        ? new Promise((resolve) => {
            releaseNotion = resolve;
          })
        : Promise.resolve([
            makeTool("t-create", "create_issue"),
            makeTool("t-delete", "delete_issue"),
          ]),
    );
    const onSelectionChange = vi.fn();
    const view = render(
      controlledEditor(new Set(["t-create"]), onSelectionChange),
    );

    await screen.findByRole("button", { name: /JIRA/ });
    await user.click(screen.getByRole("button", { name: /add/i }));
    await user.click(
      await screen.findByRole("menuitemcheckbox", { name: /notion/i }),
    );
    // The form changes the selection while Notion's tools are still loading.
    view.rerender(
      controlledEditor(new Set(["t-create", "t-delete"]), onSelectionChange),
    );
    releaseNotion([
      {
        id: "n-page",
        name: "create_page",
        description: null,
        catalogId: NOTION_ID,
      },
    ]);

    await waitFor(() =>
      expect(onSelectionChange).toHaveBeenLastCalledWith(
        new Set(["t-create", "t-delete", "n-page"]),
      ),
    );
  });

  describe("a server picked from beyond the first page", () => {
    // 60 servers before "Zulip" by name: Zulip is only on a searched page,
    // and picking it closes the menu, which clears the search.
    const ZULIP_ID = "zulip-catalog";
    beforeEach(() => {
      useInternalMcpCatalogMock.mockReturnValue({
        data: [
          makeCatalog(),
          ...Array.from({ length: 60 }, (_, i) =>
            makeCatalog({
              id: `filler-${i}`,
              name: `Filler ${String(i).padStart(2, "0")}`,
            }),
          ),
          makeCatalog({ id: ZULIP_ID, name: "Zulip" }),
        ],
      });
      fetchCatalogToolsMock.mockImplementation((id: string) =>
        Promise.resolve(
          id === ZULIP_ID
            ? [
                {
                  id: "z-send",
                  name: "send_message",
                  description: null,
                  catalogId: ZULIP_ID,
                },
              ]
            : [makeTool("t-create", "create_issue")],
        ),
      );
    });

    async function pickZulip(user: ReturnType<typeof userEvent.setup>) {
      await screen.findByRole("button", { name: /JIRA/ });
      await user.click(screen.getByRole("button", { name: /add/i }));
      await user.type(screen.getByRole("textbox"), "zulip");
      await user.click(
        await screen.findByRole("menuitemcheckbox", { name: /zulip/i }),
      );
      // Past the search debounce, the list is back on its first page.
      await waitFor(() =>
        expect(registryPageCalls.at(-1)).not.toHaveProperty("search"),
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    it("searches descriptions as well as names", async () => {
      const user = userEvent.setup();
      renderTab();

      await screen.findByRole("button", { name: /JIRA/ });
      await user.click(screen.getByRole("button", { name: /add/i }));
      await user.type(screen.getByRole("textbox"), "zulip");

      await waitFor(() =>
        expect(registryPageCalls.at(-1)).toMatchObject({
          search: "zulip",
          searchDescriptions: true,
        }),
      );
    });

    it("keeps its pill in the live editor", async () => {
      const user = userEvent.setup();
      renderTab();

      await pickZulip(user);

      // Its checklist is still open, and the pill stays once it closes.
      expect(screen.getByLabelText("send_message")).not.toBeChecked();
      await user.keyboard("{Escape}");
      expect(
        await screen.findByRole("button", { name: /^Zulip/ }),
      ).toBeInTheDocument();
    });

    it("keeps the staged tools visible and removable in the settings form", async () => {
      const user = userEvent.setup();
      let staged = new Set(["t-create"]);
      const onSelectionChange = vi.fn((next: Set<string>) => {
        staged = next;
        view.rerender(controlledEditor(staged, onSelectionChange));
      });
      const view = render(controlledEditor(staged, onSelectionChange));

      await pickZulip(user);

      expect(staged).toEqual(new Set(["t-create", "z-send"]));
      // The staged tool stays visible, and removable, in the server's checklist.
      await user.keyboard("{Escape}");
      expect(
        await screen.findByRole("button", { name: /^Zulip/ }),
      ).toHaveTextContent("(1)");
    });
  });

  it("flags an assigned server that sits outside the app's environment", async () => {
    useInternalMcpCatalogMock.mockReturnValue({
      data: [makeCatalog({ environmentId: "env-other" })],
    });
    renderTab();

    const pill = await screen.findByRole("button", { name: /JIRA/ });
    expect(pill).toHaveTextContent("outside this environment");
  });

  it("surfaces an assignment with no listed MCP server as a removable fallback", async () => {
    const user = userEvent.setup();
    // Catalog list unavailable (e.g. failed/partial fetch): the assigned tool's
    // server isn't listed, so it can't be grouped — it must stay removable.
    useInternalMcpCatalogMock.mockReturnValue({ data: [] });
    renderTab();

    expect(await screen.findByText("create_issue")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Remove create_issue" }),
    );
    expect(unassignMutate).toHaveBeenCalledWith({
      appId: APP_ID,
      toolId: "t-create",
    });
  });

  it("shows a read-only assigned list without edit affordances for viewers", async () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
    } as ReturnType<typeof useHasPermissions>);
    renderTab();

    // Assigned tool is listed, but no checkbox (no editing) is rendered.
    expect(await screen.findByText("create_issue")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(fetchCatalogToolsMock).not.toHaveBeenCalled();
  });

  it("honors a per-app read-only state despite the global update permission", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <AppToolsEditor appId={APP_ID} readOnly />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("create_issue")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(fetchCatalogToolsMock).not.toHaveBeenCalled();
  });

  it("lists the servers of the app's environment and the Default one a page at a time, loading tools only for its pills", async () => {
    const NOTION_ID = "notion-catalog";
    useAppMock.mockReturnValue({ data: { environmentId: "env-app" } });
    useInternalMcpCatalogMock.mockReturnValue({
      data: [makeCatalog(), makeCatalog({ id: NOTION_ID, name: "Notion" })],
    });
    renderTab();

    await screen.findByRole("button", { name: /JIRA/ });

    expect(registryPageCalls.at(-1)).toMatchObject({
      environmentIds: ["env-app"],
      includeDefaultEnvironment: true,
      limit: 50,
    });
    // Notion is only offered in the list: its tools are not fetched.
    expect(fetchCatalogToolsMock).toHaveBeenCalledWith(JIRA_CATALOG_ID);
    expect(fetchCatalogToolsMock).not.toHaveBeenCalledWith(NOTION_ID);
  });
});
