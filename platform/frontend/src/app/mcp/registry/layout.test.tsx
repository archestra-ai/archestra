import { render, screen } from "@testing-library/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useInternalMcpCatalog } from "@/lib/mcp/internal-mcp-catalog.query";
import {
  useMcpDeploymentStatuses,
  useMcpServers,
} from "@/lib/mcp/mcp-server.query";
import { useMcpServerIssues } from "@/lib/mcp/use-mcp-server-issues";
import McpCatalogLayout from "./layout";

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("@/lib/mcp/internal-mcp-catalog.query", () => ({
  useInternalMcpCatalog: vi.fn(),
}));
vi.mock("@/lib/mcp/mcp-server.query", () => ({
  useMcpDeploymentStatuses: vi.fn(),
  useMcpServers: vi.fn(),
}));
vi.mock("@/lib/mcp/use-mcp-server-issues", () => ({
  useMcpServerIssues: vi.fn(),
}));

describe("McpCatalogLayout", () => {
  beforeEach(() => {
    vi.mocked(usePathname).mockReturnValue("/mcp/registry");
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("status=needs-my-action") as ReturnType<
        typeof useSearchParams
      >,
    );
    vi.mocked(useRouter).mockReturnValue({
      push: vi.fn(),
      replace: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(useFeature).mockImplementation(
      (feature) => feature === "mcpServerAlertingEnabled",
    );
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
    } as ReturnType<typeof useHasPermissions>);
    vi.mocked(useInternalMcpCatalog).mockReturnValue({
      data: [{ id: "first" }, { id: "second" }, { id: "third" }],
    } as ReturnType<typeof useInternalMcpCatalog>);
    vi.mocked(useMcpServers).mockReturnValue({
      data: [],
    } as unknown as ReturnType<typeof useMcpServers>);
    vi.mocked(useMcpDeploymentStatuses).mockReturnValue({
      statuses: {},
      state: "disabled",
    });
    vi.mocked(useMcpServerIssues).mockReturnValue({
      issuesByCatalog: new Map(),
      facetCounts: { you: 1, others: 1, muted: 0 },
    });
  });

  it("renders registry audience views as header tabs", () => {
    render(
      <McpCatalogLayout>
        <div>Registry content</div>
      </McpCatalogLayout>,
    );

    expect(screen.getAllByRole("link", { name: /All.*3/ })).toHaveLength(2);
    const actionRequired = screen.getByTestId(
      "mcp-registry-action-required-tab",
    );
    expect(actionRequired).toHaveTextContent("Action required");
    expect(actionRequired).toHaveTextContent("(1)");
    expect(actionRequired).toHaveTextContent("Beta");
    expect(actionRequired).toHaveAttribute("aria-current", "page");
    expect(
      screen.queryByTestId("mcp-registry-attention-facets"),
    ).not.toBeInTheDocument();
  });
});
