import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
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
} = vi.hoisted(() => ({
  assignMutate: vi.fn(),
  unassignMutate: vi.fn(),
  useAppMock: vi.fn(),
  useAppToolsMock: vi.fn(),
  useInternalMcpCatalogMock: vi.fn(),
  fetchCatalogToolsMock: vi.fn(),
}));

vi.mock("@/lib/app.query", () => ({
  useApp: useAppMock,
  useAppTools: useAppToolsMock,
  useAppAssignableBuiltinTools: () => ({ data: [] }),
  useAssignToolToApp: () => ({ mutate: assignMutate }),
  useUnassignToolFromApp: () => ({ mutate: unassignMutate }),
}));

vi.mock("@/lib/auth/auth.query");

vi.mock("@/lib/mcp/internal-mcp-catalog.query", () => ({
  useInternalMcpCatalog: useInternalMcpCatalogMock,
  fetchCatalogTools: fetchCatalogToolsMock,
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
});
