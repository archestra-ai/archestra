import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type {
  McpServerIssue,
  McpServerIssueKind,
} from "@/lib/mcp/mcp-server-issues";
import { useMcpServerIssues } from "@/lib/mcp/use-mcp-server-issues";
import { McpRegistryAttentionBadge } from "./mcp-registry-attention-badge";

vi.mock("@/lib/mcp/mcp-server.query", () => ({
  useMcpDeploymentStatuses: () => ({ statuses: {} }),
}));
vi.mock("@/lib/mcp/use-mcp-server-issues", () => ({
  useMcpServerIssues: vi.fn(),
}));

describe("McpRegistryAttentionBadge", () => {
  it("explains the count by issue kind when focused from the keyboard", async () => {
    givenIssues({
      a: ["needs-reauth"],
      b: ["needs-reauth"],
      c: ["failed-to-start"],
      d: ["not-running", "failed-to-start"],
    });
    const user = userEvent.setup();
    render(<McpRegistryAttentionBadge />);

    const badge = screen.getByRole("link", {
      name: "4 MCP servers need attention, show them",
    });
    expect(badge).toHaveTextContent("4");

    await user.tab();
    expect(badge).toHaveFocus();
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent("4 MCP servers need attention");
    expect(tooltip).toHaveTextContent(
      "2 failed to start · 1 not running · 2 need re-authentication",
    );
    expect(tooltip).toHaveTextContent("Click to see them");
  });

  it("uses singular wording for a single server", async () => {
    givenIssues({ a: ["needs-reauth"] });
    const user = userEvent.setup();
    render(<McpRegistryAttentionBadge />);

    expect(
      screen.getByRole("link", {
        name: "1 MCP server needs attention, show them",
      }),
    ).toBeInTheDocument();
    await user.hover(screen.getByRole("link"));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "1 needs re-authentication",
    );
  });

  it("renders nothing when no server needs the viewer", () => {
    givenIssues({});
    render(<McpRegistryAttentionBadge />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});

/** Every listed catalog item carries the given kinds, all the viewer's to fix. */
function givenIssues(fleet: Record<string, McpServerIssueKind[]>) {
  const issuesByCatalog = new Map<string, McpServerIssue[]>(
    Object.entries(fleet).map(([catalogId, kinds]) => [
      catalogId,
      kinds.map((kind) => ({
        kind,
        audience: "you",
        catalogId,
        detail: null,
        since: null,
        fingerprint: `${catalogId}-${kind}`,
        muted: false,
        mutedReason: null,
      })),
    ]),
  );
  vi.mocked(useMcpServerIssues).mockReturnValue({
    issuesByCatalog,
    facetCounts: { you: issuesByCatalog.size, others: 0, muted: 0 },
  });
}
