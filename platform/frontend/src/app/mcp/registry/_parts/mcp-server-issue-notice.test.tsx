import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { McpServerIssue } from "@/lib/mcp/mcp-server-issues";
import { McpServerIssueNotice } from "./mcp-server-issue-notice";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

type Props = Parameters<typeof McpServerIssueNotice>[0];

// The catalog icon behind the name is query-backed.
const renderWithQuery = (ui: ReactElement) =>
  render(
    <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>,
  );

const item = {
  id: "cat-1",
  name: "crashy-test-server",
  icon: null,
} as Props["item"];

const server = {
  id: "srv-1",
  catalogId: "cat-1",
  name: "crashy-test-server",
  assignedAgents: [
    {
      id: "a1",
      name: "Ops",
      agentType: "agent",
      scope: "org",
      ownerEmail: null,
    },
    {
      id: "a2",
      name: "QA",
      agentType: "agent",
      scope: "org",
      ownerEmail: null,
    },
  ],
  autoModeAgents: [],
} as unknown as Props["servers"][number];

const failedToStart = (detail: string): McpServerIssue => ({
  kind: "failed-to-start",
  severity: "down",
  audience: "you",
  catalogId: "cat-1",
  serverId: "srv-1",
  detail,
  since: null,
});

/**
 * The Needs-attention row and the server Overview panel render the same
 * diagnosis at two densities. The row sits under a section header that
 * already names the trouble, so it drops the pill, the how-to-fix prose and
 * the secondary verb, and folds a short raw message into its facts line.
 */
describe("McpServerIssueNotice", () => {
  it("row: name, cause, one facts line with the raw message inline, one verb", () => {
    renderWithQuery(
      <McpServerIssueNotice
        variant="row"
        item={item}
        issues={[failedToStart("exit code 1")]}
        servers={[server]}
      />,
    );

    expect(
      screen.getByRole("link", { name: "crashy-test-server" }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "The server exited before it answered the first request.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Check the logs for the error/)).toBeNull();
    expect(screen.queryByText("Failed to start")).toBeNull();

    expect(screen.getByText("Affects 2 agents")).toBeTruthy();
    expect(screen.getByText("exit code 1")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Show details/ })).toBeNull();

    expect(screen.getByRole("button", { name: "View logs" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Edit configuration" }),
    ).toBeNull();
  });

  it("row: a long or multi-line raw message stays behind the disclosure", () => {
    renderWithQuery(
      <McpServerIssueNotice
        variant="row"
        item={item}
        issues={[failedToStart("Error: boom\n    at main (index.js:1:1)")]}
        servers={[server]}
      />,
    );

    expect(screen.getByRole("button", { name: "Show details" })).toBeTruthy();
    expect(screen.queryByText(/at main/)).toBeNull();
  });

  it("panel: keeps the pill, the fix prose and both verbs", () => {
    renderWithQuery(
      <McpServerIssueNotice
        item={item}
        issues={[failedToStart("exit code 1")]}
        servers={[server]}
        hideName
      />,
    );

    expect(screen.getByText("Failed to start")).toBeTruthy();
    expect(screen.getByText(/Check the logs for the error/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "View logs" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Edit configuration" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show details" })).toBeTruthy();
  });
});
