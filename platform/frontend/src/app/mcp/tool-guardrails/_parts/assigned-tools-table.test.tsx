import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AssignedToolsTable } from "./assigned-tools-table";

const mocks = vi.hoisted(() => ({
  callPolicyMutation: vi.fn(),
  resultPolicyMutation: vi.fn(),
}));

vi.mock("@/components/filter-bar", () => ({
  CollectionFilters: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  FilterBar: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  FilterSelect: () => <button type="button">All Sources</button>,
  filterSearchClass: "",
}));

vi.mock("@/components/search-input", () => ({
  SearchInput: () => <input aria-label="Search tools" />,
}));

vi.mock("@/components/tool-policy-bulk-actions", () => ({
  ToolPolicyBulkActionsBar: () => null,
}));

vi.mock("@/components/mcp-catalog-icon", () => ({
  McpCatalogIcon: () => <span aria-hidden>source icon</span>,
}));

vi.mock("@/components/roles/with-permissions", () => ({
  WithPermissions: ({
    children,
  }: {
    children: (params: { hasPermission: boolean }) => ReactNode;
  }) => children({ hasPermission: true }),
}));

vi.mock("@/lib/hooks/use-data-table-query-params", () => ({
  useDataTableQueryParams: () => ({
    searchParams: new URLSearchParams(),
    pageIndex: 0,
    pageSize: 10,
    updateQueryParams: vi.fn(),
    setPagination: vi.fn(),
  }),
}));

vi.mock("@/lib/mcp/internal-mcp-catalog.query", () => ({
  useInternalMcpCatalog: () => ({
    data: [
      {
        id: "catalog-1",
        name: "Document Search",
        icon: "📚",
        serverType: "remote",
      },
    ],
  }),
}));

vi.mock("@/lib/policy.query", () => ({
  useCallPolicyMutation: () => ({ mutateAsync: mocks.callPolicyMutation }),
  useResultPolicyMutation: () => ({ mutateAsync: mocks.resultPolicyMutation }),
  useToolInvocationPolicies: () => ({
    data: {
      byProfileToolId: {
        "tool-1": [
          {
            id: "call-policy-1",
            toolId: "tool-1",
            action: "allow_when_context_is_untrusted",
            conditions: [],
          },
        ],
      },
    },
  }),
  useToolResultPolicies: () => ({
    data: {
      byProfileToolId: {
        "tool-1": [
          {
            id: "result-policy-1",
            toolId: "tool-1",
            action: "mark_as_trusted",
            conditions: [],
          },
        ],
      },
    },
  }),
}));

vi.mock("@/lib/tools/tool.query", () => ({
  useToolsWithAssignments: () => ({
    isLoading: false,
    data: {
      data: [
        {
          id: "tool-1",
          name: "document_search__search_documents",
          description: "Search indexed documents",
          parameters: {},
          annotations: null,
          catalogId: "catalog-1",
          assignmentCount: 4,
          assignments: [],
          delegateToAgent: null,
          createdAt: "2026-08-23T12:00:00.000Z",
          updatedAt: "2026-08-23T12:00:00.000Z",
        },
      ],
      pagination: { total: 1, limit: 10, offset: 0 },
    },
  }),
  useAllMatchingTools: () => ({
    data: undefined,
    isFetching: false,
  }),
  useToolObservers: () => ({
    data: { users: [], clients: [] },
  }),
}));

describe("AssignedToolsTable", () => {
  beforeEach(() => {
    mocks.callPolicyMutation.mockReset();
    mocks.resultPolicyMutation.mockReset();
  });

  it("presents source and assignment context as part of the tool identity", () => {
    render(<AssignedToolsTable onToolClick={vi.fn()} />);

    const toolCell = screen.getByText("search_documents").closest("td");
    if (!toolCell) throw new Error("Expected the tool identity table cell");
    expect(within(toolCell).getByText("Document Search")).toBeVisible();
    expect(within(toolCell).getByText("4 assignments")).toBeVisible();

    expect(
      screen.queryByRole("columnheader", { name: "Source" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("columnheader", { name: "Assignments" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("columnheader", { name: "Actions" }),
    ).not.toBeInTheDocument();
  });

  it("uses readable policy labels and opens details from the row", () => {
    const onToolClick = vi.fn();
    render(<AssignedToolsTable onToolClick={onToolClick} />);

    expect(screen.getByText("Allow always")).toBeVisible();
    expect(screen.getByText("Safe")).toBeVisible();

    const row = screen.getByText("search_documents").closest("tr");
    if (!row) throw new Error("Expected the tool row");
    fireEvent.click(row);
    expect(onToolClick).toHaveBeenCalledTimes(1);
  });

  it("keeps inline policy controls from opening row details", () => {
    const onToolClick = vi.fn();
    render(<AssignedToolsTable onToolClick={onToolClick} />);

    fireEvent.click(screen.getByText("Allow always"));
    expect(onToolClick).not.toHaveBeenCalled();
  });
});
