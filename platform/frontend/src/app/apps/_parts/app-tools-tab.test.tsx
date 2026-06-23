import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Radix Accordion/Checkbox measure layout and use pointer capture, which jsdom
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

const {
  assignMutate,
  unassignMutate,
  useAppMock,
  useAppToolsMock,
  useHasPermissionsMock,
  useInternalMcpCatalogMock,
  fetchCatalogToolsMock,
} = vi.hoisted(() => ({
  assignMutate: vi.fn(),
  unassignMutate: vi.fn(),
  useAppMock: vi.fn(),
  useAppToolsMock: vi.fn(),
  useHasPermissionsMock: vi.fn(),
  useInternalMcpCatalogMock: vi.fn(),
  fetchCatalogToolsMock: vi.fn(),
}));

vi.mock("@/lib/app.query", () => ({
  useApp: useAppMock,
  useAppTools: useAppToolsMock,
  useAssignToolToApp: () => ({ mutate: assignMutate }),
  useUnassignToolFromApp: () => ({ mutate: unassignMutate }),
}));

vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: useHasPermissionsMock,
}));

vi.mock("@/lib/mcp/internal-mcp-catalog.query", () => ({
  useInternalMcpCatalog: useInternalMcpCatalogMock,
  fetchCatalogTools: fetchCatalogToolsMock,
}));

// The catalog icon pulls in white-label app-name hooks the bare render lacks.
vi.mock("@/components/mcp-catalog-icon", () => ({
  McpCatalogIcon: () => null,
}));

import { AppToolsTab } from "./app-tools-tab";

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
      <AppToolsTab appId={APP_ID} />
    </QueryClientProvider>,
  );
}

describe("AppToolsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppMock.mockReturnValue({ data: { environmentId: null } });
    useHasPermissionsMock.mockReturnValue({ data: true });
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
    renderTab();

    // The server (catalog) heading renders, with the assigned-count badge.
    expect(await screen.findByText("JIRA")).toBeInTheDocument();
    expect(screen.getByText("1 selected")).toBeInTheDocument();

    // Tools load into the default-open section; the assigned one is checked.
    const created = await screen.findByLabelText("create_issue");
    const deleted = await screen.findByLabelText("delete_issue");
    expect(created).toBeChecked();
    expect(deleted).not.toBeChecked();
  });

  it("assigns a tool with dynamic credentials when checked", async () => {
    const user = userEvent.setup();
    renderTab();

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

    await user.click(await screen.findByLabelText("create_issue"));

    expect(unassignMutate).toHaveBeenCalledWith({
      appId: APP_ID,
      toolId: "t-create",
    });
    expect(assignMutate).not.toHaveBeenCalled();
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
    useHasPermissionsMock.mockReturnValue({ data: false });
    renderTab();

    // Assigned tool is listed, but no checkbox (no editing) is rendered.
    expect(await screen.findByText("create_issue")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(fetchCatalogToolsMock).not.toHaveBeenCalled();
  });
});
