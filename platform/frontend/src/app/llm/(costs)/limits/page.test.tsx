import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LimitsPage from "./page";

const mockSetCostsAction = vi.fn();

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
  useLimits: () => ({ data: [], isPending: false }),
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

vi.mock("@/components/ui/permission-button", () => ({
  PermissionButton: ({ children }: { children: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
}));

vi.mock("@/components/llm-model-select", () => ({
  LlmModelSearchableSelect: () => <div>Model filter</div>,
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

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
}));

describe("LimitsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
