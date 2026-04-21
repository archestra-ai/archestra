import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import { useDateTimeRangePicker } from "@/lib/hooks/use-date-time-range-picker";
import { useInteractions } from "@/lib/interactions/interaction.query";
import { useMcpToolCalls } from "@/lib/mcp/mcp-tool-call.query";
import AuditLogPage from "./page.client";

vi.mock("@shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shared")>();

  return {
    ...actual,
    DynamicInteraction: class MockDynamicInteraction {
      private interaction: Record<string, unknown>;
      modelName?: string;

      constructor(interaction: Record<string, unknown>) {
        this.interaction = interaction;
        this.modelName = interaction.__dynamicModelName as string | undefined;
      }

      getToolNamesRefused() {
        return (this.interaction.__blockedTools as string[] | undefined) ?? [];
      }

      getLastUserMessage() {
        return this.interaction.__lastUserMessage as string | undefined;
      }
    },
    parseFullToolName: (fullToolName: string) => ({
      toolName: fullToolName.split("/").at(-1) ?? fullToolName,
    }),
  };
});

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(),
}));

vi.mock("@/lib/hooks/use-data-table-query-params", () => ({
  useDataTableQueryParams: vi.fn(),
}));

vi.mock("@/lib/hooks/use-date-time-range-picker", () => ({
  useDateTimeRangePicker: vi.fn(),
}));

vi.mock("@/lib/interactions/interaction.query", () => ({
  useInteractions: vi.fn(),
}));

vi.mock("@/lib/mcp/mcp-tool-call.query", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/mcp/mcp-tool-call.query")>();

  return {
    ...actual,
    useMcpToolCalls: vi.fn(),
  };
});

vi.mock("@/components/page-layout", () => ({
  PageLayout: ({
    title,
    description,
    tabs,
    children,
  }: {
    title: string;
    description: ReactNode;
    tabs: Array<{ label: string; href: string }>;
    children: ReactNode;
  }) => (
    <section>
      <h1>{title}</h1>
      <div>{description}</div>
      <nav>
        {tabs.map((tab) => (
          <span key={tab.href}>{tab.label}</span>
        ))}
      </nav>
      {children}
    </section>
  ),
}));

vi.mock("@/components/table-filters", () => ({
  TableFilters: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/search-input", () => ({
  SearchInput: ({
    placeholder,
    value,
    onSearchChange,
  }: {
    placeholder: string;
    value: string;
    onSearchChange: (value: string) => void;
  }) => (
    <input
      aria-label="Search audit events"
      defaultValue={value}
      placeholder={placeholder}
      onChange={(event) => onSearchChange(event.target.value)}
    />
  ),
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    children: ReactNode;
  }) => (
    <select
      aria-label="Audit type filter"
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

vi.mock("@/components/ui/date-time-range-picker", () => ({
  DateTimeRangePicker: ({ displayText }: { displayText: string | null }) => (
    <div>{displayText ?? "All dates"}</div>
  ),
}));

vi.mock("@/components/ui/data-table", () => ({
  DataTable: ({
    data,
    emptyMessage,
    filteredEmptyMessage,
    hasActiveFilters,
    isLoading,
    onClearFilters,
    onRowClick,
  }: {
    data: Array<{
      id: string;
      type: string;
      actor: string;
      status: string;
      summary: string;
      href: string;
    }>;
    emptyMessage: string;
    filteredEmptyMessage: string;
    hasActiveFilters: boolean;
    isLoading: boolean;
    onClearFilters: () => void;
    onRowClick?: (row: {
      id: string;
      type: string;
      actor: string;
      status: string;
      summary: string;
      href: string;
    }) => void;
  }) => {
    if (isLoading) {
      return <div>Loading table</div>;
    }

    if (data.length === 0) {
      return (
        <div>
          <div>{hasActiveFilters ? filteredEmptyMessage : emptyMessage}</div>
          <button type="button" onClick={onClearFilters}>
            Clear filters
          </button>
        </div>
      );
    }

    return (
      <div>
        <button type="button" onClick={onClearFilters}>
          Clear filters
        </button>
        {data.map((row) => (
          <button key={row.id} type="button" onClick={() => onRowClick?.(row)}>
            {`${row.type}:${row.actor}:${row.status}:${row.summary}`}
          </button>
        ))}
      </div>
    );
  },
}));

const mockRouterPush = vi.fn();
const mockUpdateQueryParams = vi.fn();
const mockClearDateRange = vi.fn();

describe("AuditLogPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(useRouter).mockReturnValue({
      push: mockRouterPush,
    } as unknown as ReturnType<typeof useRouter>);

    vi.mocked(useDataTableQueryParams).mockReturnValue({
      ...createDataTableQueryParams(),
    });

    vi.mocked(useDateTimeRangePicker).mockReturnValue({
      startDate: undefined,
      endDate: undefined,
      isDateDialogOpen: false,
      tempStartDate: undefined,
      tempEndDate: undefined,
      setIsDateDialogOpen: vi.fn(),
      setTempStartDate: vi.fn(),
      setTempEndDate: vi.fn(),
      openDateDialog: vi.fn(),
      handleApplyDateRange: vi.fn(),
      clearDateRange: mockClearDateRange,
      getDateRangeDisplay: () => null,
      startDateParam: undefined,
      endDateParam: undefined,
    });

    vi.mocked(useInteractions).mockReturnValue(
      createQueryResult([
        {
          id: "llm-1",
          createdAt: "2026-04-20T10:00:00.000Z",
          type: "openai:responses",
          model: "gpt-5",
          userId: "alex@company.com",
          source: "Web App",
          __lastUserMessage: "Sent chat completion request",
        },
        {
          id: "llm-2",
          createdAt: "2026-04-20T09:00:00.000Z",
          type: "openai:responses",
          model: "gpt-5-mini",
          userId: "maria@company.com",
          source: "Web App",
          __blockedTools: ["postgres.query"],
        },
      ]) as unknown as ReturnType<typeof useInteractions>,
    );

    vi.mocked(useMcpToolCalls).mockReturnValue(
      createQueryResult([
        {
          id: "mcp-1",
          createdAt: "2026-04-20T11:00:00.000Z",
          method: "tools/call",
          mcpServerName: "Postgres",
          authMethod: "oauth",
          userName: "agent:finance",
          toolCall: { name: "postgres/query" },
          toolResult: { isError: true },
        },
      ]) as unknown as ReturnType<typeof useMcpToolCalls>,
    );
  });

  it("renders combined audit events with summary counts", () => {
    render(<AuditLogPage />);

    expect(screen.getByText("Audit Log")).toBeVisible();
    expect(screen.getByText("Loaded events")).toBeVisible();
    expect(screen.getByText("3")).toBeVisible();
    expect(screen.getByText("1")).toBeVisible();
    expect(screen.getByText("2")).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: "MCP:agent:finance:Failed:Called query on Postgres",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: "LLM:alex@company.com:Allowed:Sent chat completion request",
      }),
    ).toBeVisible();
  });

  it("updates query params when search and type filters change", async () => {
    const user = userEvent.setup();

    render(<AuditLogPage />);

    await user.type(
      screen.getByRole("textbox", { name: "Search audit events" }),
      "postgres",
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Audit type filter" }),
      "MCP",
    );

    expect(mockUpdateQueryParams).toHaveBeenCalledWith({
      search: "postgres",
    });
    expect(mockUpdateQueryParams).toHaveBeenCalledWith({
      type: "MCP",
    });
  });

  it("clears all filters and date range from the table action", async () => {
    const user = userEvent.setup();

    vi.mocked(useDataTableQueryParams).mockReturnValue({
      ...createDataTableQueryParams(
        new URLSearchParams(
          "search=postgres&type=MCP&startDate=2026-04-20T00%3A00%3A00.000Z&endDate=2026-04-20T23%3A59%3A59.999Z",
        ),
      ),
    });

    vi.mocked(useDateTimeRangePicker).mockReturnValue({
      startDate: new Date("2026-04-20T00:00:00.000Z"),
      endDate: new Date("2026-04-20T23:59:59.999Z"),
      isDateDialogOpen: false,
      tempStartDate: undefined,
      tempEndDate: undefined,
      setIsDateDialogOpen: vi.fn(),
      setTempStartDate: vi.fn(),
      setTempEndDate: vi.fn(),
      openDateDialog: vi.fn(),
      handleApplyDateRange: vi.fn(),
      clearDateRange: mockClearDateRange,
      getDateRangeDisplay: () => "Apr 20, 2026",
      startDateParam: "2026-04-20T00:00:00.000Z",
      endDateParam: "2026-04-20T23:59:59.999Z",
    });

    render(<AuditLogPage />);

    await user.click(screen.getByRole("button", { name: "Clear filters" }));

    expect(mockClearDateRange).toHaveBeenCalledTimes(1);
    expect(mockUpdateQueryParams).toHaveBeenCalledWith({
      search: null,
      type: null,
      startDate: null,
      endDate: null,
    });
  });

  it("navigates to the underlying log detail page when a row is clicked", async () => {
    const user = userEvent.setup();

    render(<AuditLogPage />);

    await user.click(
      screen.getByRole("button", {
        name: "MCP:agent:finance:Failed:Called query on Postgres",
      }),
    );

    expect(mockRouterPush).toHaveBeenCalledWith("/mcp/logs/mcp-1");
  });

  it("disables the LLM query when the MCP filter is active", () => {
    vi.mocked(useDataTableQueryParams).mockReturnValue({
      ...createDataTableQueryParams(new URLSearchParams("type=MCP")),
    });

    render(<AuditLogPage />);

    expect(vi.mocked(useInteractions)).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: false,
      }),
    );
    expect(vi.mocked(useMcpToolCalls)).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
      }),
    );
    expect(
      screen.getByRole("button", {
        name: "MCP:agent:finance:Failed:Called query on Postgres",
      }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", {
        name: "LLM:alex@company.com:Allowed:Sent chat completion request",
      }),
    ).not.toBeInTheDocument();
  });
});

function createQueryResult<T extends Record<string, unknown>>(data: T[]) {
  return {
    data: {
      data,
      pagination: {
        currentPage: 1,
        limit: 100,
        total: data.length,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
      },
    },
    isFetching: false,
  } as const;
}

function createDataTableQueryParams(searchParams = new URLSearchParams()) {
  return {
    searchParams: searchParams as unknown as ReturnType<
      typeof useDataTableQueryParams
    >["searchParams"],
    pathname: "/audit-log",
    pageIndex: 0,
    pageSize: 100,
    offset: 0,
    updateQueryParams: mockUpdateQueryParams,
    setPagination: vi.fn(),
  } as ReturnType<typeof useDataTableQueryParams>;
}
