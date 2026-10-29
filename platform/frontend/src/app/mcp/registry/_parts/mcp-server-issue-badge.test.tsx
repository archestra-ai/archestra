import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { McpServerIssue } from "@/lib/mcp/mcp-server-issues";
import { McpServerIssueBadge } from "./mcp-server-issue-badge";

const reauthIssue = (onViewerConnection: boolean): McpServerIssue => ({
  kind: "needs-reauth",
  audience: onViewerConnection ? "you" : "others",
  onViewerConnection,
  catalogId: "c1",
  serverId: "s1",
  detail: null,
  since: null,
  fingerprint: "f",
  muted: false,
  mutedReason: null,
});

describe("McpServerIssueBadge", () => {
  it("tells the viewer their own connection needs re-authentication", () => {
    render(<McpServerIssueBadge issue={reauthIssue(true)} />);
    expect(screen.getByText("Needs re-authentication")).toBeInTheDocument();
  });

  it("says a colleague's lost sign-in is theirs, not the viewer's", () => {
    render(<McpServerIssueBadge issue={reauthIssue(false)} />);
    expect(
      screen.getByText("Someone else's sign-in expired"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Needs re-authentication"),
    ).not.toBeInTheDocument();
  });
});
