import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LimitsPage, { getLimitModels } from "./page";

const mockSetCostsAction = vi.fn();
const mockUseLimits = vi.fn();
const mockUseAllVirtualApiKeys = vi.fn();

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
  useCreateLimit: () => ({ mutateAsync: vi.fn() }),
  useUpdateLimit: () => ({ mutateAsync: vi.fn() }),
  useDeleteLimit: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock("@/lib/teams/team.query", () => ({
  useTeams: () => ({ data: [] }),
}));

vi.mock("@/lib/organization.query", () => ({
  useOrganization: () => ({
    data: { id: "org-1", limitCleanupInterval: "1m" },
  }),
  useOrganizationMembers: () => ({ data: [] }),
}));

vi.mock("@/lib/virtual-api-keys.query", () => ({
  useAllVirtualApiKeys: (...args: unknown[]) =>
    mockUseAllVirtualApiKeys(...args),
}));

vi.mock("@/lib/llm-models.query", () => ({
  useModelsWithApiKeys: () => ({
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

vi.mock("@/lib/agent.query", () => ({
  useProfiles: (params?: { filters?: { agentTypes?: string[] } }) => {
    const agentType = params?.filters?.agentTypes?.[0];
    if (agentType === "agent") {
      return { data: [{ id: "agent-1", name: "Test Agent" }] };
    }
    if (agentType === "llm_proxy") {
      return { data: [{ id: "proxy-1", name: "Test LLM Proxy" }] };
    }
    return { data: [] };
  },
}));

vi.mock("@/lib/hooks/use-data-table-query-params", () => ({
  useDataTableQueryParams: () => ({
    searchParams: new URLSearchParams(),
    updateQueryParams: vi.fn(),
  }),
}));

vi.mock("@/components/loading", () => ({
  LoadingSpinner: () => <div>Loading</div>,
  LoadingWrapper: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@/components/ui/data-table", () => ({
  DataTable: ({
    data,
    columns,
  }: {
    data: Array<Record<string, unknown>>;
    columns: Array<{
      cell?: (info: {
        row: { original: Record<string, unknown> };
      }) => React.ReactNode;
    }>;
  }) => (
    <div>
      {data.map((row: Record<string, unknown>) => (
        <div
          key={String(row.id)}
          data-testid={`data-table-row-${String(row.id)}`}
        >
          {columns.map(
            (
              col: {
                cell?: (info: {
                  row: { original: Record<string, unknown> };
                }) => React.ReactNode;
              },
              _colIndex: number,
            ) => (
              <span key={Math.random()}>
                {col.cell ? col.cell({ row: { original: row } }) : null}
              </span>
            ),
          )}
        </div>
      ))}
    </div>
  ),
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/ui/searchable-select", () => ({
  SearchableSelect: () => <div>SearchableSelect</div>,
}));

vi.mock("@/components/ui/permission-button", () => ({
  PermissionButton: ({ children }: { children: React.ReactNode }) => (
    <button type="button">{children}</button>
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
  DialogForm: ({ children }: { children: React.ReactNode }) => (
    <form>{children}</form>
  ),
  DialogStickyFooter: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/delete-confirm-dialog", () => ({
  DeleteConfirmDialog: () => null,
}));

vi.mock("@/components/table-row-actions", () => ({
  TableRowActions: () => null,
}));

vi.mock("@/components/ui/progress", () => ({
  Progress: () => <div />,
}));

vi.mock("@/components/ui/input", () => ({
  Input: () => <input />,
}));

vi.mock("@/components/ui/label", () => ({
  Label: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
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

describe("LimitsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseLimits.mockReturnValue({ data: [], isPending: false });
    mockUseAllVirtualApiKeys.mockReturnValue({
      data: { data: [], pagination: { total: 0 } },
    });
  });

  it("shows the active cleanup interval and links to LLM settings", () => {
    render(<LimitsPage />);

    expect(
      screen.getByText(
        /expired or exceeded limits reset on the current cleanup schedule/i,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Every month")).toBeInTheDocument();

    expect(
      screen.getByRole("link", { name: /change it in llm settings/i }),
    ).toHaveAttribute("href", "/settings/llm");
  });

  it("requests virtual keys with the API-supported page size", () => {
    render(<LimitsPage />);

    expect(mockUseAllVirtualApiKeys).toHaveBeenCalledWith({ limit: 100 });
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

  it("shows LLM proxy name in table for llm_proxy-type limits", () => {
    mockUseLimits.mockReturnValue({
      data: [
        {
          id: "limit-proxy",
          entityType: "agent",
          entityId: "proxy-1",
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
    const row = screen.getByTestId("data-table-row-limit-proxy");
    expect(row).toHaveTextContent("Test LLM Proxy");
  });

  it("shows 'Unknown LLM proxy' when proxy is not found", () => {
    mockUseLimits.mockReturnValue({
      data: [
        {
          id: "limit-proxy",
          entityType: "agent",
          entityId: "unknown-proxy",
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
    const row = screen.getByTestId("data-table-row-limit-proxy");
    expect(row).toHaveTextContent("Unknown LLM proxy");
  });
});
