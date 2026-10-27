import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render as rtlRender,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import type { ReactElement, ReactNode } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import LimitsPage, { getLimitModels } from "./page";

const mockSetCostsAction = vi.fn();
const mockUseLimits = vi.fn();
const mockCreateLimit = vi.fn();
const mockUpdateLimit = vi.fn();
const mockUseAllVirtualApiKeys = vi.fn();
const mockDataTableSearchParams = vi.fn(() => new URLSearchParams());
const mockUpdateQueryParams = vi.fn();

// The ?edit= dialog deep-link syncs open state to the URL through
// useDialogUrlParam, which reads next/navigation hooks. Bare vi.mock resolves
// to the root-level __mocks__/next/navigation.ts (all hooks are vi.fn()s,
// configured in beforeEach).
vi.mock("next/navigation");

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

vi.mock("@/app/llm/(costs)/layout", () => ({
  useSetCostsAction: () => mockSetCostsAction,
}));

vi.mock("@/lib/limits.query", () => ({
  useLimits: (...args: unknown[]) => mockUseLimits(...args),
  useCreateLimit: () => ({ mutateAsync: mockCreateLimit }),
  useUpdateLimit: () => ({ mutateAsync: mockUpdateLimit }),
  useDeleteLimit: () => ({ mutateAsync: vi.fn() }),
  useBulkDeleteLimits: () => ({ mutate: vi.fn(), isPending: false }),
}));

// The create dialog notes when a default user limit exists.
vi.mock("@/lib/default-user-limit.query", () => ({
  useDefaultUserLimits: () => ({ data: [{ id: "dul-1" }] }),
}));

// The per-user limits card has its own tests (user-limits-overview.test.tsx);
// here it only frames the explicit limits table.
vi.mock("./_parts/user-limits-overview", () => ({
  UserLimitsOverview: ({ limitsTable }: { limitsTable: ReactNode }) =>
    limitsTable,
}));

vi.mock("@/lib/environment.query", () => ({
  useEnvironments: () => ({ data: { environments: [] } }),
}));

vi.mock("@/lib/teams/team.query");

vi.mock("@/lib/organization.query");

vi.mock("@/lib/llm-oauth-clients.query", () => ({
  useLlmOauthClients: () => ({
    data: { data: [{ id: "client-1", name: "CI runner", clientId: "oc_1" }] },
  }),
}));

vi.mock("@/lib/virtual-api-keys.query", () => ({
  useAllVirtualApiKeys: (...args: unknown[]) =>
    mockUseAllVirtualApiKeys(...args),
}));

vi.mock("@/lib/llm-models.query", () => ({
  useLlmModelOptions: () => ({
    data: [
      {
        modelId: "gpt-4o",
        provider: "openai",
        pricePerMillionInput: "2.50",
        pricePerMillionOutput: "10.00",
      },
      {
        modelId: "claude-3.5-sonnet",
        provider: "anthropic",
        pricePerMillionInput: "3.00",
        pricePerMillionOutput: "15.00",
      },
    ],
  }),
}));

vi.mock("@/lib/agent-options.query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent-options.query")>()),
  useAgentOptionsByIds: (params: {
    ids: readonly string[];
    filters?: { agentType?: string };
  }) => ({
    data:
      params.filters?.agentType === "agent" && params.ids.includes("agent-1")
        ? [{ id: "agent-1", name: "Test Agent" }]
        : [],
  }),
}));

vi.mock("@/lib/hooks/use-data-table-query-params", () => ({
  useDataTableQueryParams: () => ({
    searchParams: mockDataTableSearchParams(),
    updateQueryParams: mockUpdateQueryParams,
    pageIndex: 0,
    pageSize: 10,
    setPagination: vi.fn(),
  }),
}));

vi.mock("@/lib/auth/auth.query");

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  useHasPermissions,
  useMissingPermissions,
} from "@/lib/auth/auth.query";
import { useOrganization } from "@/lib/organization.query";
import { useTeams } from "@/lib/teams/team.query";

vi.mock("@/components/loading", () => ({
  LoadingState: () => <div>Loading</div>,
  LoadingWrapper: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@/components/ui/data-table", () => ({
  DataTable: ({
    data,
    columns,
    getRowId = (row: Record<string, unknown>) => String(row.id),
  }: {
    data: Array<Record<string, unknown>>;
    getRowId?: (row: Record<string, unknown>) => string;
    columns: Array<{
      id?: string;
      accessorKey?: string;
      cell?: (info: {
        row: {
          original: Record<string, unknown>;
          getIsSelected: () => boolean;
          toggleSelected: (selected: boolean) => void;
        };
      }) => React.ReactNode;
    }>;
  }) => (
    <div>
      {data.map((row: Record<string, unknown>) => (
        <div
          key={getRowId(row)}
          data-testid={`data-table-row-${getRowId(row)}`}
        >
          {columns.map(
            (col: {
              id?: string;
              accessorKey?: string;
              cell?: (info: {
                row: {
                  original: Record<string, unknown>;
                  getIsSelected: () => boolean;
                  toggleSelected: (selected: boolean) => void;
                };
              }) => React.ReactNode;
            }) => (
              <span key={col.id ?? col.accessorKey}>
                {col.cell
                  ? col.cell({
                      row: {
                        original: row,
                        getIsSelected: () => false,
                        toggleSelected: vi.fn(),
                      },
                    })
                  : null}
              </span>
            ),
          )}
        </div>
      ))}
    </div>
  ),
}));

vi.mock("@/components/llm-model-select", () => ({
  LlmModelSearchableSelect: () => <div>Model filter</div>,
}));

vi.mock("@/components/llm-model-multi-select", () => ({
  LlmModelMultiSearchableSelect: () => <div>Model multi filter</div>,
}));

vi.mock("@/components/llm-model-picker", () => ({
  LlmModelPicker: ({
    value,
    placeholder,
    multiple,
  }: {
    value: string | string[];
    placeholder?: string;
    multiple?: boolean;
  }) => (
    <div data-testid={multiple ? "multi-select" : "single-select"}>
      {Array.isArray(value) && value.length === 0
        ? placeholder || "All models"
        : Array.isArray(value) && value.includes("all")
          ? "All models"
          : Array.isArray(value)
            ? value.join(",")
            : value || placeholder}
    </div>
  ),
}));

vi.mock("@/components/form-dialog", () => ({
  FormDialog: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/ui/dialog", () => ({
  DialogBody: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogForm: (props: React.ComponentProps<"form">) => <form {...props} />,
  DialogStickyFooter: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/delete-confirm-dialog", () => ({
  DeleteConfirmDialog: () => null,
}));

vi.mock("@/components/ui/progress", () => ({
  Progress: () => <div />,
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: React.ComponentProps<"input">) => <input {...props} />,
}));

vi.mock("@/components/ui/alert", () => ({
  Alert: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDescription: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({
    children,
    ...props
  }: {
    children: React.ReactNode;
    [key: string]: unknown;
  }) => <span {...props}>{children}</span>,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
}));

vi.mock("@/components/ui/checkbox", () => ({
  Checkbox: ({
    checked,
    onCheckedChange,
    id,
  }: {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    id: string;
  }) => (
    <input
      type="checkbox"
      data-testid={id}
      checked={checked}
      onChange={(e) => onCheckedChange(e.target.checked)}
    />
  ),
}));

vi.mock("@/components/searchable-multi-select", () => ({
  SearchableMultiSelect: ({
    value,
    placeholder,
  }: {
    value: string[];
    onValueChange: (v: string[]) => void;
    placeholder?: string;
  }) => (
    <div data-testid="multi-select">
      {value.length === 0 ? placeholder || "All models" : value.join(",")}
    </div>
  ),
}));
vi.mock("@/lib/entity-labels.query");

describe("LimitsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // JSDOM has no layout/scroll API; keep the real Select behavior.
    Element.prototype.scrollIntoView = vi.fn();
    vi.mocked(usePathname).mockReturnValue("/llm/limits");
    vi.mocked(useRouter).mockReturnValue({
      replace: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
    );
    mockDataTableSearchParams.mockReturnValue(new URLSearchParams());
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
      isPending: false,
    } as unknown as ReturnType<typeof useHasPermissions>);
    vi.mocked(useMissingPermissions).mockReturnValue(
      [] as unknown as ReturnType<typeof useMissingPermissions>,
    );
    vi.mocked(useTeams).mockReturnValue({
      data: [],
    } as unknown as ReturnType<typeof useTeams>);
    vi.mocked(useOrganization).mockReturnValue({
      data: { id: "org-1", defaultUserLimitValue: 100 },
    } as unknown as ReturnType<typeof useOrganization>);
    mockUseLimits.mockReturnValue({ data: [], isPending: false });
    mockUseAllVirtualApiKeys.mockReturnValue({
      data: { data: [], pagination: { total: 0 } },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows a model carried from Costs even when it is absent from the provider catalog", () => {
    mockDataTableSearchParams.mockReturnValue(
      new URLSearchParams({ units: "tokens", model: "vendor/retired-model" }),
    );
    render(<LimitsPage />);
    expect(
      screen.getByRole("combobox", { name: "Filter by model" }),
    ).toHaveTextContent("vendor/retired-model");
    expect(
      screen.getByRole("combobox", { name: "Filter by model" }),
    ).not.toHaveTextContent("All models");
  });

  it("keeps a selected Costs entity visible and combines it with kind and model filters", () => {
    mockDataTableSearchParams.mockReturnValue(
      new URLSearchParams({
        appliedTo: "team",
        entityId: "team-alpha",
        units: "tokens",
        model: "model-a",
      }),
    );
    mockUseLimits.mockReturnValue({
      data: [
        {
          ...limitRow({ id: "matching", limitValue: 100 }),
          entityType: "team",
          entityId: "team-alpha",
          limitType: "tokens",
          model: ["model-a"],
        },
        {
          ...limitRow({ id: "other-team", limitValue: 100 }),
          entityType: "team",
          entityId: "team-beta",
          limitType: "tokens",
          model: ["model-a"],
        },
        {
          ...limitRow({ id: "other-kind", limitValue: 100 }),
          entityType: "team",
          entityId: "team-alpha",
          limitType: "requests",
          model: ["model-a"],
        },
      ],
      isPending: false,
    });
    render(<LimitsPage />);
    expect(screen.getByTestId("data-table-row-matching")).toBeInTheDocument();
    expect(
      screen.queryByTestId("data-table-row-other-team"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("data-table-row-other-kind"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Filter by entity" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(mockUpdateQueryParams).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: null, page: null }),
    );
  });

  it("omits the table notice while retaining the units filter and actual token guidance", () => {
    render(<LimitsPage />);
    expect(
      screen.queryByText("Matching limits apply together"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "How limits apply" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Filter by limit kind" }),
    ).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Limit kind" }), {
      key: "Enter",
    });
    fireEvent.click(screen.getByRole("option", { name: "Tokens" }));
    expect(
      screen.getByText(/Counts token usage reported by the provider/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Input and output tokens are estimated/),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Limit value")).toBeInTheDocument();
  });

  it.each([
    ["token_cost", "Spend"],
    ["requests", "Requests"],
    ["requests_per_minute", "Requests"],
    ["tokens", "Tokens"],
    ["tokens_per_minute", "Tokens"],
  ])("shows a visible kind label for %s even when usage is unavailable", (limitType, label) => {
    mockUseLimits.mockReturnValue({
      data: [
        {
          ...limitRow({ id: "kind-row", limitValue: 100 }),
          limitType,
          throughputUsage: null,
        },
      ],
      isPending: false,
    });
    render(<LimitsPage />);
    const row = screen.getByTestId("data-table-row-kind-row");
    expect(within(row).getByText(label, { exact: true })).toBeInTheDocument();
    expect(
      within(row).getByRole("button", { name: /^Edit limit/ }),
    ).toBeInTheDocument();
  });

  it.each([
    "",
    "all",
    "unknown-unit",
  ])("shows every unit for the unfiltered or unknown URL value %s", (units) => {
    mockDataTableSearchParams.mockReturnValue(new URLSearchParams({ units }));
    mockUseLimits.mockReturnValue({
      data: unitFilterRows(),
      isPending: false,
    });
    render(<LimitsPage />);
    expect(screen.getAllByTestId(/^data-table-row-/)).toHaveLength(32);
    expect(
      screen.getByRole("combobox", { name: "Filter by limit kind" }),
    ).toHaveTextContent("All kinds");
  });

  it.each([
    ["token_cost", "Spend", 10],
    ["requests", "Requests", 11],
    ["tokens", "Tokens", 11],
  ] as const)("filters %s across every interval including its persisted aliases", (units, label, count) => {
    mockDataTableSearchParams.mockReturnValue(new URLSearchParams({ units }));
    mockUseLimits.mockReturnValue({
      data: unitFilterRows(),
      isPending: false,
    });
    render(<LimitsPage />);
    const rows = screen.getAllByTestId(/^data-table-row-/);
    expect(rows).toHaveLength(count);
    for (const row of rows) {
      expect(row.getAttribute("data-testid")).toContain(`row-${units}-`);
    }
    expect(
      screen.getByRole("combobox", { name: "Filter by limit kind" }),
    ).toHaveTextContent(label);
    if (units === "token_cost") {
      expect(
        screen.getByTestId("data-table-row-token_cost-minute"),
      ).toHaveTextContent("$0.00 of $100");
    } else {
      expect(
        screen.getByTestId(`data-table-row-${units}-legacy`),
      ).toHaveTextContent("Usage unavailable");
    }
  });

  it("combines units with status, scope and model instead of widening the match", () => {
    const matching = {
      ...limitRow({
        id: "match",
        entityType: "team",
        entityId: "team-1",
        limitValue: 100,
      }),
      limitType: "tokens",
      model: ["gpt-4o"],
      throughputUsage: { currentUsage: 95, resetsAt: null },
    };
    mockUseLimits.mockReturnValue({
      data: [
        matching,
        { ...matching, id: "wrong-unit", limitType: "requests" },
        { ...matching, id: "wrong-scope", entityType: "organization" },
        { ...matching, id: "wrong-model", model: ["claude-3.5-sonnet"] },
        {
          ...matching,
          id: "wrong-status",
          throughputUsage: { currentUsage: 5, resetsAt: null },
        },
        { ...matching, id: "aggregate", model: null },
      ],
      isPending: false,
    });
    mockDataTableSearchParams.mockReturnValue(
      new URLSearchParams(
        "units=tokens&status=danger&appliedTo=team&model=gpt-4o",
      ),
    );
    render(<LimitsPage />);
    expect(
      screen
        .getAllByTestId(/^data-table-row-/)
        .map((row) => row.getAttribute("data-testid")),
    ).toEqual(["data-table-row-match", "data-table-row-aggregate"]);
  });

  it("places the limit kind filter after the other filters", () => {
    render(<LimitsPage />);
    const kind = screen.getByRole("combobox", {
      name: "Filter by limit kind",
    });
    for (const name of ["All statuses", "All applied to", "Filter by model"]) {
      const control = screen.getByRole("combobox", { name });
      expect(control.compareDocumentPosition(kind)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
    }
  });

  it("offers kinds without search and resets the page when choosing a kind or all kinds", async () => {
    const user = userEvent.setup();
    mockDataTableSearchParams.mockReturnValue(
      new URLSearchParams("units=tokens&page=3&other=retained"),
    );
    render(<LimitsPage />);
    const filter = screen.getByRole("combobox", {
      name: "Filter by limit kind",
    });
    filter.focus();
    await user.keyboard("{Enter}");
    const list = screen.getByRole("listbox", { name: "Filter by limit kind" });
    expect(within(list).queryByRole("textbox")).not.toBeInTheDocument();
    expect(
      within(list)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["All kinds", "Spend", "Tokens", "Requests"]);
    fireEvent.click(within(list).getByRole("option", { name: "Requests" }));
    expect(mockUpdateQueryParams).toHaveBeenLastCalledWith({
      units: "requests",
      page: null,
    });
    await user.click(filter);
    fireEvent.click(screen.getByRole("option", { name: "All kinds" }));
    expect(mockUpdateQueryParams).toHaveBeenLastCalledWith({
      units: null,
      page: null,
    });
  });

  it("offers organization budgets without a proxy scope for new limits", () => {
    render(<LimitsPage />);

    fireEvent.click(screen.getByRole("combobox", { name: "Limit scope" }));

    const scopes = screen.getByRole("listbox", { name: "Limit scope" });
    expect(
      within(scopes).getByRole("option", { name: /Organization/ }),
    ).toBeInTheDocument();
    expect(
      within(scopes).getByRole("option", { name: /Agent/ }),
    ).toBeInTheDocument();
    expect(
      within(scopes).queryByRole("option", { name: /LLM Proxy/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      within(scopes).getByRole("option", { name: /Organization/ }),
    );
    fireEvent.change(screen.getByLabelText("Limit value"), {
      target: { value: "100" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create limit" }));
    expect(mockCreateLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "organization",
        entityId: "org-1",
        limitValue: 100,
      }),
    );
  });

  it("saves a pending label after Advanced is collapsed", () => {
    render(<LimitsPage />);

    const key = screen.getByLabelText("Label key");
    expect(key).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /^Advanced$/ }));
    fireEvent.change(key, { target: { value: "stage" } });
    fireEvent.change(screen.getByLabelText("Label value"), {
      target: { value: "preview" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Advanced$/ }));
    expect(key).not.toBeVisible();
    fireEvent.change(screen.getByLabelText("Limit value"), {
      target: { value: "100" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create limit" }));
    expect(mockCreateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ labels: [{ key: "stage", value: "preview" }] }),
    );
  });

  it("omits the proxy scope from the applied-to filter", () => {
    render(<LimitsPage />);
    fireEvent.click(screen.getByRole("combobox", { name: "All applied to" }));
    const scopes = screen.getByRole("listbox", { name: "All applied to" });
    expect(
      within(scopes).queryByRole("option", { name: /LLM Proxy/ }),
    ).not.toBeInTheDocument();
    expect(
      within(scopes).getByRole("option", { name: /Organization/ }),
    ).toBeInTheDocument();
  });

  it("does not reinterpret decimal, negative or excessive amounts when pasted", () => {
    render(<LimitsPage />);
    const amount = screen.getByLabelText("Limit value");
    expect(amount).not.toHaveAttribute("aria-describedby");
    for (const value of ["1.50", "1,50", "1,2", "-1", "2147483648"]) {
      fireEvent.change(amount, { target: { value } });
      expect(amount).toHaveValue(value);
      expect(
        screen.getByRole("button", { name: "Create limit" }),
      ).toBeDisabled();
      expect(amount).toHaveAccessibleDescription(
        /Enter a whole number from 1 to/,
      );
    }
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Limit kind" }), {
      key: "Enter",
    });
    fireEvent.click(screen.getByRole("option", { name: "Requests" }));
    fireEvent.change(amount, { target: { value: "1.5" } });
    expect(amount).toHaveValue("1.5");
    expect(screen.getByRole("button", { name: "Create limit" })).toBeDisabled();
    fireEvent.submit(amount.closest("form") as HTMLFormElement);
    expect(mockCreateLimit).not.toHaveBeenCalled();
    fireEvent.change(amount, { target: { value: "1,000" } });
    expect(amount).not.toHaveAttribute("aria-describedby");
    expect(
      screen.queryByText(/Enter a whole number from 1 to/),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create limit" })).toBeEnabled();
  });

  it("allows typing a six-digit allowance without inserting invalid grouping", async () => {
    const user = userEvent.setup();
    render(<LimitsPage />);
    const amount = screen.getByLabelText("Limit value");
    await user.type(amount, "100000");
    expect(amount).toHaveValue("100000");
    expect(screen.getByRole("button", { name: "Create limit" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Create limit" }));
    expect(mockCreateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ limitValue: 100000 }),
    );
  });

  it("groups Per minute under Rate before Rolling and Calendar intervals", () => {
    render(<LimitsPage />);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Interval" }), {
      key: "Enter",
    });
    const list = screen.getByRole("listbox");
    const groups = within(list).getAllByRole("group");
    expect(groups).toHaveLength(3);
    expect(groups[0]).toHaveAccessibleName("Rate");
    expect(groups[1]).toHaveAccessibleName("Rolling");
    expect(groups[2]).toHaveAccessibleName("Calendar");
    expect(within(groups[0]).getAllByRole("option")).toHaveLength(1);
    fireEvent.click(
      within(groups[0]).getByRole("option", { name: "Per minute" }),
    );
    expect(
      screen.getByRole("combobox", { name: "Interval" }),
    ).toHaveTextContent("Per minute");
    expect(mockCreateLimit).not.toHaveBeenCalled();
  });

  it("changes the default interval with limit kind until an interval is chosen", () => {
    render(<LimitsPage />);
    const interval = screen.getByRole("combobox", { name: "Interval" });
    expect(interval).toHaveTextContent("Calendar month");
    for (const [kind, expected] of [
      ["Tokens", "Per minute"],
      ["Requests", "Per minute"],
      ["Spend", "Calendar month"],
    ]) {
      fireEvent.keyDown(screen.getByRole("combobox", { name: "Limit kind" }), {
        key: "Enter",
      });
      fireEvent.click(screen.getByRole("option", { name: kind }));
      expect(interval).toHaveTextContent(expected);
    }
    fireEvent.keyDown(interval, { key: "Enter" });
    fireEvent.click(screen.getByRole("option", { name: "Rolling day" }));
    for (const kind of ["Tokens", "Requests", "Spend"]) {
      fireEvent.keyDown(screen.getByRole("combobox", { name: "Limit kind" }), {
        key: "Enter",
      });
      fireEvent.click(screen.getByRole("option", { name: kind }));
      expect(interval).toHaveTextContent("Rolling day");
    }
  });

  it("preserves an explicit selection of the already-selected default interval", () => {
    render(<LimitsPage />);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Interval" }), {
      key: "Enter",
    });
    fireEvent.click(screen.getByRole("option", { name: "Calendar month" }));
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Limit kind" }), {
      key: "Enter",
    });
    fireEvent.click(screen.getByRole("option", { name: "Tokens" }));
    expect(
      screen.getByRole("combobox", { name: "Interval" }),
    ).toHaveTextContent("Calendar month");
    expect(mockCreateLimit).not.toHaveBeenCalled();
  });

  it("does not treat opening and dismissing the interval picker as a choice", () => {
    render(<LimitsPage />);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Interval" }), {
      key: "Enter",
    });
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Limit kind" }), {
      key: "Enter",
    });
    fireEvent.click(screen.getByRole("option", { name: "Tokens" }));
    expect(
      screen.getByRole("combobox", { name: "Interval" }),
    ).toHaveTextContent("Per minute");
  });

  it("shows the monthly spend example without setting a default amount", () => {
    render(<LimitsPage />);
    expect(screen.getByLabelText("Limit value")).toHaveAttribute(
      "placeholder",
      "e.g. 2,000",
    );
    expect(screen.getByLabelText("Limit value")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Create limit" })).toBeDisabled();
  });

  it.each([
    ["Per minute", ["1", "60", "100,000"]],
    ["Rolling hour", ["10", "1,000", "1,000,000"]],
    ["Rolling 12 hours", ["50", "5,000", "5,000,000"]],
    ["Rolling day", ["100", "10,000", "10,000,000"]],
    ["Calendar day", ["100", "10,000", "10,000,000"]],
    ["Rolling week", ["500", "50,000", "50,000,000"]],
    ["Calendar week (Sun-Sat)", ["500", "50,000", "50,000,000"]],
    ["Calendar week (Mon-Sun)", ["500", "50,000", "50,000,000"]],
    ["Rolling month", ["2,000", "200,000", "200,000,000"]],
    ["Calendar month", ["2,000", "200,000", "200,000,000"]],
  ] as const)("uses unit-specific examples for %s without prefilling", (interval, examples) => {
    render(<LimitsPage />);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Interval" }), {
      key: "Enter",
    });
    fireEvent.click(screen.getByRole("option", { name: interval }));
    for (const [index, unit] of ["Spend", "Requests", "Tokens"].entries()) {
      fireEvent.keyDown(screen.getByRole("combobox", { name: "Limit kind" }), {
        key: "Enter",
      });
      fireEvent.click(screen.getByRole("option", { name: unit }));
      expect(screen.getByLabelText("Limit value")).toHaveAttribute(
        "placeholder",
        `e.g. ${examples[index]}`,
      );
      expect(screen.getByLabelText("Limit value")).toHaveValue("");
      expect(
        screen.getByRole("button", { name: "Create limit" }),
      ).toBeDisabled();
    }
  });

  it("changes interval examples without replacing an entered amount and clears only on unit change", () => {
    render(<LimitsPage />);
    const amount = screen.getByLabelText("Limit value");
    fireEvent.change(amount, { target: { value: "12345" } });
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Interval" }), {
      key: "Enter",
    });
    fireEvent.click(screen.getByRole("option", { name: "Per minute" }));
    expect(amount).toHaveAttribute("placeholder", "e.g. 1");
    expect(amount).toHaveValue("12345");
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Limit kind" }), {
      key: "Enter",
    });
    fireEvent.click(screen.getByRole("option", { name: "Requests" }));
    expect(amount).toHaveValue("");
    expect(amount).toHaveAttribute("placeholder", "e.g. 60");
    expect(screen.getByRole("button", { name: "Create limit" })).toBeDisabled();
  });

  it("selects separately labeled token kind and a per-minute interval", () => {
    render(<LimitsPage />);
    expect(screen.getByLabelText("Limit kind", { exact: true })).toBe(
      screen.getByRole("combobox", { name: "Limit kind" }),
    );
    expect(
      screen.queryByRole("combobox", { name: "Limit type" }),
    ).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Limit kind" }), {
      key: "Enter",
    });
    fireEvent.click(screen.getByRole("option", { name: "Tokens" }));
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Interval" }), {
      key: "Enter",
    });
    fireEvent.click(screen.getByRole("option", { name: "Per minute" }));
    fireEvent.click(screen.getByRole("combobox", { name: "Limit scope" }));
    const scopes = screen.getByRole("listbox", { name: "Limit scope" });
    expect(
      within(scopes).queryByRole("option", { name: /Agent/ }),
    ).not.toBeInTheDocument();
    expect(
      within(scopes).queryByRole("option", { name: /User/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      within(scopes).getByRole("option", { name: /Organization/ }),
    );
    fireEvent.change(screen.getByLabelText("Limit value"), {
      target: { value: "10000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create limit" }));
    expect(mockCreateLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "organization",
        entityId: "org-1",
        limitType: "tokens",
        limitValue: 10000,
        cleanupInterval: "minute",
      }),
    );
  });

  it.each([
    ["Spend", "token_cost", "Per minute", "minute"],
    ["Tokens", "tokens", "Calendar day", "calendar_day"],
    ["Requests", "requests", "Calendar month", "calendar_month"],
  ])("creates %s limits using their selected interval", (units, limitType, intervalLabel, cleanupInterval) => {
    render(<LimitsPage />);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Limit kind" }), {
      key: "Enter",
    });
    fireEvent.click(screen.getByRole("option", { name: units }));
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Interval" }), {
      key: "Enter",
    });
    fireEvent.click(screen.getByRole("option", { name: intervalLabel }));
    fireEvent.change(screen.getByLabelText("Limit value"), {
      target: { value: "250" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create limit" }));
    expect(mockCreateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ limitType, cleanupInterval, limitValue: 250 }),
    );
  });

  it("shows 'All models' badge for limits with null model", () => {
    mockUseLimits.mockReturnValue({
      data: [
        {
          id: "limit-1",
          entityType: "organization",
          entityId: "org-1",
          limitType: "token_cost",
          limitValue: 1000,
          model: null,
          mcpServerName: null,
          toolName: null,
          lastCleanup: null,
          createdAt: "2026-01-01",
          updatedAt: "2026-01-01",
          modelUsage: [],
        },
      ],
      isPending: false,
    });

    render(<LimitsPage />);
    const modelsBadge = screen.getByTestId("limits-table-models-badge");
    expect(modelsBadge).toHaveTextContent("All models");
  });

  it("shows why a custom user limit was set under the user", () => {
    mockUseLimits.mockReturnValue({
      data: [
        {
          id: "limit-1",
          entityType: "user",
          entityId: "user-1",
          limitType: "token_cost",
          limitValue: 500,
          model: null,
          reason: "Runs the nightly eval suite",
          mcpServerName: null,
          toolName: null,
          lastCleanup: null,
          createdAt: "2026-01-01",
          updatedAt: "2026-01-01",
          modelUsage: [],
        },
      ],
      isPending: false,
    });

    render(<LimitsPage />);

    expect(screen.getByText("Runs the nightly eval suite")).toBeVisible();
  });

  it("shows usage with cents so sub-dollar spend is not rounded away", () => {
    mockUseLimits.mockReturnValue({
      data: [
        {
          id: "limit-1",
          entityType: "organization",
          entityId: "org-1",
          limitType: "token_cost",
          limitValue: 1,
          model: null,
          mcpServerName: null,
          toolName: null,
          lastCleanup: null,
          createdAt: "2026-01-01",
          updatedAt: "2026-01-01",
          modelUsage: [
            { model: "gpt-4o", tokensIn: 0, tokensOut: 0, cost: 0.45 },
          ],
        },
      ],
      isPending: false,
    });

    render(<LimitsPage />);

    expect(screen.getByTestId("data-table-row-limit-1")).toHaveTextContent(
      "$0.45 of $1 (45.0%)",
    );
  });

  it.each([
    [
      "token_cost",
      "minute",
      0.45,
      2,
      "$0.45 of $2 (22.5%)",
      "Per minute",
      null,
    ],
    [
      "requests",
      "minute",
      3,
      100,
      "3 of 100 requests (3.0%)",
      "Per minute",
      null,
    ],
    [
      "tokens",
      "minute",
      250,
      1000,
      "250 of 1,000 tokens (25.0%)",
      "Per minute",
      null,
    ],
    [
      "tokens",
      "calendar_day",
      250,
      1000,
      "250 of 1,000 tokens (25.0%)",
      "Calendar day",
      "Resets",
    ],
    [
      "requests",
      "1m",
      3,
      100,
      "3 of 100 requests (3.0%)",
      "Rolling month",
      "Resets",
    ],
  ])("formats %s row values and recovery for %s", (limitType, cleanupInterval, used, limitValue, amount, interval, recovery) => {
    mockUseLimits.mockReturnValue({
      data: [
        {
          ...limitRow({ id: "units-row", limitValue }),
          limitType,
          cleanupInterval,
          throughputUsage: {
            currentUsage: used,
            resetsAt: "2026-02-01T00:00:00.000Z",
          },
        },
      ],
      isPending: false,
    });
    render(<LimitsPage />);
    const row = screen.getByTestId("data-table-row-units-row");
    expect(row).toHaveTextContent(amount);
    expect(row).toHaveTextContent(interval);
    if (recovery) {
      expect(row).toHaveTextContent(recovery);
    } else {
      expect(
        within(row).getByText("Per minute", { exact: true }),
      ).toBeVisible();
      expect(row).not.toHaveTextContent("Resets");
    }
    expect(row).not.toHaveTextContent("Recovers continuously");
    expect(row).not.toHaveTextContent("tokens/min");
    expect(row).not.toHaveTextContent("requests/min");
    expect(within(row).getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      String((used / limitValue) * 100),
    );
  });

  it("does not display unavailable token usage as zero or an empty progress bar", () => {
    mockUseLimits.mockReturnValue({
      data: [
        {
          ...limitRow({ id: "unavailable", limitValue: 1000 }),
          limitType: "tokens",
          cleanupInterval: "calendar_day",
          throughputUsage: null,
        },
      ],
      isPending: false,
    });
    render(<LimitsPage />);
    const row = screen.getByTestId("data-table-row-unavailable");
    expect(row).toHaveTextContent("— of 1,000 tokens");
    expect(row).toHaveTextContent("Usage unavailable");
    expect(row).not.toHaveTextContent("0.0%");
    expect(within(row).queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("opens the correct rule from its direct Edit action without an action menu", async () => {
    mockUseLimits.mockReturnValue({
      data: [
        limitRow({ id: "spend", limitValue: 250 }),
        {
          ...limitRow({ id: "tokens", limitValue: 100000 }),
          limitType: "tokens",
          cleanupInterval: "minute",
        },
      ],
      isPending: false,
    });
    render(<LimitsPage />);
    const row = screen.getByTestId("data-table-row-tokens");
    expect(
      within(row).getByRole("button", {
        name: "Delete limit Organization Tokens",
      }),
    ).toBeEnabled();
    expect(
      within(row).queryByRole("button", { name: /More actions/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      within(row).getByRole("button", {
        name: "Edit limit Organization Tokens",
      }),
    );
    expect(
      await screen.findByRole("button", { name: "Save changes" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Limit value")).toHaveValue("100000");
    expect(
      screen.getByRole("combobox", { name: "Limit kind" }),
    ).toHaveTextContent("Tokens");
  });

  it("keeps direct Edit and Delete actions disabled without permissions", () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
      isPending: false,
      missingPermissions: { llmLimit: ["update", "delete"] },
    } as unknown as ReturnType<typeof useHasPermissions>);
    mockUseLimits.mockReturnValue({
      data: [limitRow({ id: "read-only", limitValue: 250 })],
      isPending: false,
    });
    render(<LimitsPage />);
    const row = screen.getByTestId("data-table-row-read-only");
    const edit = within(row).getByRole("button", {
      name: "Edit limit Organization Spend",
    });
    expect(edit).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(edit);
    expect(
      screen.queryByRole("button", { name: "Save changes" }),
    ).not.toBeInTheDocument();
    expect(
      within(row).getByRole("button", {
        name: "Delete limit Organization Spend",
      }),
    ).toHaveAttribute("aria-disabled", "true");
  });

  it("shows the next reset date for rolling monthly limits", () => {
    mockUseLimits.mockReturnValue({
      data: [
        {
          id: "limit-1",
          entityType: "organization",
          entityId: "org-1",
          limitType: "token_cost",
          limitValue: 1000,
          model: null,
          mcpServerName: null,
          toolName: null,
          cleanupInterval: "1m",
          lastCleanup: "2026-01-15T12:00:00.000Z",
          createdAt: "2026-01-01",
          updatedAt: "2026-01-01",
          modelUsage: [],
        },
      ],
      isPending: false,
    });

    render(<LimitsPage />);

    const row = screen.getByTestId("data-table-row-limit-1");
    expect(row).toHaveTextContent("Rolling month");
    expect(row).toHaveTextContent("Resets Feb 15");
  });

  it("clears an active label filter with the other limit filters", () => {
    mockDataTableSearchParams.mockReturnValue(
      new URLSearchParams(
        "units=tokens&status=safe&appliedTo=team&model=gpt-4o&labels=stage%3Aproduction&page=3",
      ),
    );

    render(<LimitsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    expect(mockUpdateQueryParams).toHaveBeenCalledWith({
      status: null,
      units: null,
      appliedTo: null,
      entityId: null,
      model: null,
      labels: null,
      page: null,
    });
  });

  it("shows the next reset date for calendar monthly limits", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00.000Z"));
    mockUseLimits.mockReturnValue({
      data: [
        {
          id: "limit-1",
          entityType: "organization",
          entityId: "org-1",
          limitType: "token_cost",
          limitValue: 1000,
          model: null,
          mcpServerName: null,
          toolName: null,
          cleanupInterval: "calendar_month",
          lastCleanup: "2026-01-02T12:00:00.000Z",
          createdAt: "2026-01-01",
          updatedAt: "2026-01-01",
          modelUsage: [],
        },
      ],
      isPending: false,
    });

    render(<LimitsPage />);

    const row = screen.getByTestId("data-table-row-limit-1");
    expect(row).toHaveTextContent("Calendar month");
    expect(row).toHaveTextContent("Resets Feb 1");
  });

  it("distinguishes over, exact and available limits in their rule rows", () => {
    mockUseLimits.mockReturnValue({
      data: [
        limitRow({ id: "limit-over", limitValue: 25, cost: 26.1 }),
        limitRow({ id: "limit-at", limitValue: 25, cost: 25 }),
        limitRow({ id: "limit-safe", limitValue: 1000, cost: 10 }),
      ],
      isPending: false,
    });

    render(<LimitsPage />);

    expect(screen.getByTestId("data-table-row-limit-over")).toHaveTextContent(
      "Over limit",
    );
    expect(screen.getByTestId("data-table-row-limit-at")).toHaveTextContent(
      "At limit",
    );
    const safeRow = screen.getByTestId("data-table-row-limit-safe");
    expect(safeRow).toHaveTextContent("$10.00 of $1,000 (1.0%)");
    expect(safeRow).not.toHaveTextContent("At limit");
    expect(safeRow).not.toHaveTextContent("Over limit");
    expect(screen.queryByText(/Over by.*0\\.00/)).not.toBeInTheDocument();
  });

  it("requires an explicit rate amount and clears amounts when changing units", () => {
    render(<LimitsPage />);
    const amount = screen.getByLabelText("Limit value");
    fireEvent.change(amount, { target: { value: "25" } });
    for (const [metric, value] of [
      ["Requests", "60"],
      ["Tokens", "100000"],
      ["Spend", "500"],
    ]) {
      fireEvent.keyDown(screen.getByRole("combobox", { name: "Limit kind" }), {
        key: "Enter",
      });
      const list = screen.getByRole("listbox");
      expect(within(list).queryByRole("textbox")).not.toBeInTheDocument();
      fireEvent.click(within(list).getByRole("option", { name: metric }));
      expect(amount).toHaveValue("");
      expect(
        screen.getByRole("button", { name: "Create limit" }),
      ).toBeDisabled();
      fireEvent.submit(amount.closest("form") as HTMLFormElement);
      expect(mockCreateLimit).not.toHaveBeenCalled();
      fireEvent.change(amount, { target: { value } });
      expect(
        screen.getByRole("button", { name: "Create limit" }),
      ).toBeEnabled();
    }
  });

  it("keeps scope rules distinct without inventing a parent allocation across different models", () => {
    vi.mocked(useTeams).mockReturnValue({
      data: [{ id: "team-1", name: "Platform" }],
    } as unknown as ReturnType<typeof useTeams>);
    mockUseAllVirtualApiKeys.mockReturnValue({
      data: {
        data: [
          {
            id: "key-1",
            name: "Deploy key",
            billingTeam: { id: "team-1", name: "Platform" },
          },
        ],
        pagination: { total: 1 },
      },
    });
    mockUseLimits.mockReturnValue({
      data: [
        limitRow({
          id: "limit-key",
          entityType: "virtual_key",
          entityId: "key-1",
          limitValue: 250,
        }),
        {
          ...limitRow({ id: "limit-org", limitValue: 2500 }),
          model: ["model-a"],
        },
        {
          ...limitRow({
            id: "limit-team",
            entityType: "team",
            entityId: "team-1",
            limitValue: 800,
          }),
          model: ["model-b"],
        },
      ],
      isPending: false,
    });

    render(<LimitsPage />);

    expect(screen.getAllByTestId(/^data-table-row-/)).toHaveLength(3);
    expect(screen.getByTestId("data-table-row-limit-team")).toHaveTextContent(
      "Platform",
    );
    expect(screen.getByTestId("data-table-row-limit-team")).toHaveTextContent(
      "model-b",
    );
    expect(screen.getByTestId("data-table-row-limit-org")).toHaveTextContent(
      "model-a",
    );
    expect(
      screen.queryByRole("button", { name: /under this one/ }),
    ).not.toBeInTheDocument();
  });

  it("shows multiple model badges for limits with multiple models", () => {
    const models = getLimitModels({
      id: "limit-1",
      entityType: "organization",
      entityId: "org-1",
      limitType: "token_cost",
      limitValue: 1000,
      model: ["gpt-4o", "claude-3.5-sonnet"],
      mcpServerName: null,
      toolName: null,
      lastCleanup: null,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      modelUsage: [],
    } as unknown as Parameters<typeof getLimitModels>[0]);

    expect(models).toEqual(["gpt-4o", "claude-3.5-sonnet"]);
  });

  it("shows only the first three models and a tooltip for remaining models", () => {
    mockUseLimits.mockReturnValue({
      data: [
        {
          id: "limit-1",
          entityType: "organization",
          entityId: "org-1",
          limitType: "token_cost",
          limitValue: 1000,
          model: [
            "gpt-4o",
            "claude-3.5-sonnet",
            "gemini-1.5-pro",
            "gpt-4.1",
            "claude-3.7-sonnet",
          ],
          mcpServerName: null,
          toolName: null,
          lastCleanup: null,
          createdAt: "2026-01-01",
          updatedAt: "2026-01-01",
          modelUsage: [],
        },
      ],
      isPending: false,
    });

    render(<LimitsPage />);

    expect(screen.getAllByTestId("limits-table-models-badge")).toHaveLength(3);
    expect(
      screen.getByTestId("limits-table-models-more-badge"),
    ).toHaveTextContent("+2 more");
    expect(screen.getByText("gpt-4.1")).toBeInTheDocument();
    expect(screen.getByText("claude-3.7-sonnet")).toBeInTheDocument();
  });

  it("shows 'All models' in multi-select when editing limit with null model", () => {
    mockUseLimits.mockReturnValue({
      data: [
        {
          id: "limit-1",
          entityType: "organization",
          entityId: "org-1",
          limitType: "token_cost",
          limitValue: 1000,
          model: null,
          mcpServerName: null,
          toolName: null,
          lastCleanup: null,
          createdAt: "2026-01-01",
          updatedAt: "2026-01-01",
          modelUsage: [],
        },
      ],
      isPending: false,
    });

    render(<LimitsPage />);

    // The multi-select mock should show "All models" when value is empty
    const multiSelect = screen.getByTestId("multi-select");
    expect(multiSelect).toHaveTextContent("All models");
  });

  it("shows agent name in table for agent-type limits", () => {
    mockUseLimits.mockReturnValue({
      data: [
        {
          id: "limit-agent",
          entityType: "agent",
          entityId: "agent-1",
          limitType: "token_cost",
          limitValue: 1000,
          model: null,
          mcpServerName: null,
          toolName: null,
          lastCleanup: null,
          createdAt: "2026-01-01",
          updatedAt: "2026-01-01",
          modelUsage: [],
        },
      ],
      isPending: false,
    });

    render(<LimitsPage />);
    const row = screen.getByTestId("data-table-row-limit-agent");
    expect(row).toHaveTextContent("Test Agent");
  });

  it("names the OAuth client a client spend cap applies to", () => {
    mockUseLimits.mockReturnValue({
      data: [
        {
          id: "limit-client",
          entityType: "llm_oauth_client",
          entityId: "client-1",
          limitType: "token_cost",
          limitValue: 200,
          model: null,
          mcpServerName: null,
          toolName: null,
          lastCleanup: null,
          createdAt: "2026-01-01",
          updatedAt: "2026-01-01",
          modelUsage: [],
        },
      ],
      isPending: false,
    });

    render(<LimitsPage />);
    const row = screen.getByTestId("data-table-row-limit-client");
    expect(row).toHaveTextContent("CI runner");
  });

  it("shows 'Unknown agent' for an agent row that no longer resolves", () => {
    mockUseLimits.mockReturnValue({
      data: [
        {
          id: "limit-unknown-agent",
          entityType: "agent",
          entityId: "unknown-agent",
          limitType: "token_cost",
          limitValue: 1000,
          model: null,
          mcpServerName: null,
          toolName: null,
          lastCleanup: null,
          createdAt: "2026-01-01",
          updatedAt: "2026-01-01",
          modelUsage: [],
        },
      ],
      isPending: false,
    });

    render(<LimitsPage />);
    const row = screen.getByTestId("data-table-row-limit-unknown-agent");
    expect(row).toHaveTextContent("Unknown agent");
    expect(row).toHaveTextContent("Agent");
  });

  it("opens the edit dialog seeded from an ?edit= deep link", async () => {
    const limit = {
      id: "limit-agent",
      entityType: "agent",
      entityId: "agent-1",
      limitType: "token_cost",
      limitValue: 1000,
      model: null,
      mcpServerName: null,
      toolName: null,
      lastCleanup: null,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      modelUsage: [],
    };
    mockUseLimits.mockReturnValue({ data: [limit], isPending: false });
    const params = new URLSearchParams({ edit: limit.id });
    mockDataTableSearchParams.mockReturnValue(params);
    vi.mocked(useSearchParams).mockReturnValue(
      params as unknown as ReturnType<typeof useSearchParams>,
    );

    render(<LimitsPage />);

    expect(await screen.findByText("Save changes")).toBeInTheDocument();
    expect(screen.getByLabelText("Limit value")).toHaveValue("1000");
    expect(screen.getByLabelText("Limit value")).toHaveAttribute(
      "placeholder",
      "e.g. 2,000",
    );
    expect(
      screen.getByRole("combobox", { name: "Limit scope" }),
    ).toHaveTextContent("Agent");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(mockUpdateLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        id: limit.id,
        entityType: "agent",
        entityId: "agent-1",
        limitValue: 1000,
      }),
    );
  });

  it("edits a persisted per-minute token rule through units and another interval", async () => {
    const limit = {
      ...limitRow({ id: "legacy-tpm", limitValue: 100000 }),
      limitType: "tokens_per_minute",
      cleanupInterval: "minute",
    };
    mockUseLimits.mockReturnValue({ data: [limit], isPending: false });
    const params = new URLSearchParams({ edit: limit.id });
    mockDataTableSearchParams.mockReturnValue(params);
    vi.mocked(useSearchParams).mockReturnValue(
      params as unknown as ReturnType<typeof useSearchParams>,
    );
    render(<LimitsPage />);
    await screen.findByText("Save changes");
    expect(
      screen.getByRole("combobox", { name: "Limit kind" }),
    ).toHaveTextContent("Tokens");
    expect(screen.getByRole("combobox", { name: "Limit kind" })).toBeDisabled();
    expect(screen.getByLabelText("Limit value")).toHaveValue("100000");
    expect(screen.getByLabelText("Limit value")).toHaveAttribute(
      "placeholder",
      "e.g. 100,000",
    );
    expect(
      screen.getByRole("combobox", { name: "Interval" }),
    ).toHaveTextContent("Per minute");
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Interval" }), {
      key: "Enter",
    });
    fireEvent.click(screen.getByRole("option", { name: "Calendar day" }));
    expect(screen.getByLabelText("Limit value")).toHaveValue("100000");
    expect(screen.getByLabelText("Limit value")).toHaveAttribute(
      "placeholder",
      "e.g. 10,000,000",
    );
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(mockUpdateLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        id: limit.id,
        limitType: "tokens",
        cleanupInterval: "calendar_day",
        limitValue: 100000,
      }),
    );
  });
});

function unitFilterRows() {
  const intervals = [
    "minute",
    "1h",
    "12h",
    "24h",
    "1w",
    "1m",
    "calendar_day",
    "calendar_week_sunday",
    "calendar_week_monday",
    "calendar_month",
  ];
  const rows = ["token_cost", "requests", "tokens"].flatMap((limitType) =>
    intervals.map((cleanupInterval) => ({
      ...limitRow({ id: `${limitType}-${cleanupInterval}`, limitValue: 100 }),
      limitType,
      cleanupInterval,
    })),
  );
  return [
    ...rows,
    ...["requests", "tokens"].map((unit) => ({
      ...limitRow({ id: `${unit}-legacy`, limitValue: 100 }),
      limitType: `${unit}_per_minute`,
    })),
  ];
}

function limitRow({
  id,
  entityType = "organization",
  entityId = "org-1",
  limitValue,
  cost = 0,
}: {
  id: string;
  entityType?: string;
  entityId?: string;
  limitValue: number;
  cost?: number;
}) {
  return {
    id,
    entityType,
    entityId,
    limitType: "token_cost",
    limitValue,
    model: null,
    mcpServerName: null,
    toolName: null,
    cleanupInterval: "calendar_month",
    lastCleanup: null,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    labels: [],
    modelUsage: [{ model: "gpt-4o", tokensIn: 0, tokensOut: 0, cost }],
  };
}

const agentServer = setupServer(
  http.get("http://localhost:9000/api/agents/options", () =>
    HttpResponse.json({
      data: [
        { id: "agent-1", name: "Test Agent", agentType: "agent", scope: "org" },
      ],
      pagination: { limit: 1000, hasNext: false, nextCursor: null },
    }),
  ),
  http.get("http://localhost:9000/api/agents/options/page", () =>
    HttpResponse.json({
      data: [
        { id: "agent-1", name: "Test Agent", agentType: "agent", scope: "org" },
      ],
      pagination: { limit: 20, hasNext: false, nextCursor: null },
    }),
  ),
);
beforeAll(() => {
  archestraApiClient.setConfig({ baseUrl: "http://localhost:9000" });
  agentServer.listen({ onUnhandledRequest: "error" });
});
afterEach(() => agentServer.resetHandlers());
afterAll(() => {
  agentServer.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});
function render(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return rtlRender(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}
