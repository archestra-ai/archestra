import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LimitsPage, { getLimitModels } from "./page";

const mockSetCostsAction = vi.fn();
const mockUseLimits = vi.fn();

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
  useAllVirtualApiKeys: () => ({
    data: { data: [], pagination: { total: 0 } },
  }),
}));

vi.mock("@/lib/llm-models.query", () => ({
  useModelsWithApiKeys: () => ({ data: [] }),
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
  DataTable: () => <div>Limits table</div>,
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
  Badge: ({ children }: { children: React.ReactNode }) => (
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

vi.mock("@/components/ui/multi-select", () => ({
  MultiSelect: ({
    value,
    allLabel,
  }: {
    value: string[];
    onValueChange: (v: string[]) => void;
    allLabel?: string;
  }) => (
    <div data-testid="multi-select">
      {value.length === 0 ? allLabel || "All" : value.join(",")}
    </div>
  ),
}));

describe("LimitsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseLimits.mockReturnValue({ data: [], isPending: false });
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
    expect(screen.getByText("All models")).toBeInTheDocument();
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
});
