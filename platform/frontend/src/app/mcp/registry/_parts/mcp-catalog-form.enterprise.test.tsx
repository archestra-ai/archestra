import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEnterpriseFeature } from "@/lib/config/config.query";
import { McpCatalogForm } from "./mcp-catalog-form";

vi.mock("@/lib/config/config.query", () => ({
  useFeature: vi.fn((feature: string) => {
    if (feature === "mcpServerBaseImage") return "";
    if (feature === "orchestratorK8sRuntime") return true;
    if (feature === "byosEnabled") return false;
    return undefined;
  }),
  useEnterpriseFeature: vi.fn(() => false),
}));

vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: vi.fn(() => ({ data: true })),
}));

vi.mock("@/lib/teams/team.query", () => ({
  useTeams: vi.fn(() => ({ data: [] })),
}));

vi.mock("@/lib/mcp/internal-mcp-catalog.query", () => ({
  useK8sImagePullSecrets: vi.fn(() => ({ data: [] })),
}));

vi.mock("@/lib/secrets.query", () => ({
  useGetSecret: vi.fn(() => ({ data: null })),
}));

vi.mock("@/lib/docs/docs", () => ({
  getVisibleDocsUrl: vi.fn(() => "https://docs.example.com"),
}));

vi.mock("@/components/agent-icon-picker", () => ({
  AgentIconPicker: () => <div data-testid="agent-icon-picker" />,
}));

vi.mock("@/components/agent-labels", () => ({
  ProfileLabels: () => <div data-testid="profile-labels" />,
}));

vi.mock("@/components/environment-variables-form-field", () => ({
  EnvironmentVariablesFormField: () => (
    <div data-testid="environment-variables-form-field" />
  ),
}));

vi.mock("@/components/visibility-selector", () => ({
  VisibilitySelector: () => <div data-testid="visibility-selector" />,
}));

describe("McpCatalogForm enterprise gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  it("hides enterprise-managed credentials when the enterprise license is disabled", () => {
    render(<McpCatalogForm mode="create" onSubmit={vi.fn()} />);

    expect(
      screen.queryByText("Enterprise-managed credentials"),
    ).not.toBeInTheDocument();
  });

  it("shows enterprise-managed credentials when the enterprise license is enabled", async () => {
    vi.mocked(useEnterpriseFeature).mockReturnValue(true);

    render(<McpCatalogForm mode="create" onSubmit={vi.fn()} />);

    expect(
      screen.getByText("Enterprise-managed credentials"),
    ).toBeInTheDocument();
  });
});
