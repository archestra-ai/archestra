import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { McpServerIssue } from "@/lib/mcp/mcp-server-issues";
import { McpServerIssueNotice } from "./mcp-server-issue-notice";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

vi.mock("@/lib/auth/auth.query", () => ({
  useSession: () => ({ data: { user: { id: "user-me" } } }),
  useHasPermissions: () => ({ data: false }),
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
  ownerId: "user-me",
  assignedAgents: [],
  autoModeAgents: [],
} as unknown as Props["servers"][number];

const failedToStart = (
  detail: string,
  overrides: Partial<McpServerIssue> = {},
): McpServerIssue => ({
  kind: "failed-to-start",
  severity: "down",
  audience: "you",
  catalogId: "cat-1",
  serverId: "srv-1",
  detail,
  since: null,
  muted: false,
  mutedReason: null,
  ...overrides,
});

const needsReauth = (
  overrides: Partial<McpServerIssue> = {},
): McpServerIssue => ({
  kind: "needs-reauth",
  severity: "down",
  audience: "you",
  catalogId: "cat-1",
  serverId: "srv-1",
  detail: null,
  since: null,
  muted: false,
  mutedReason: null,
  ...overrides,
});

/**
 * The row and the server Overview panel render the same diagnosis. The row
 * used to drop the pill, the how-to-fix sentence and the secondary verb on the
 * theory that a section header supplied them; there is no section header any
 * more, so the row has to carry the whole answer itself.
 */
describe("McpServerIssueNotice", () => {
  it("row: pill, cause, how to fix it, both verbs and the connection count", () => {
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
    expect(screen.getByText("Failed to start")).toBeTruthy();
    expect(
      screen.getByText(
        "The server exited before it answered the first request.",
      ),
    ).toBeTruthy();
    expect(screen.getByText(/Check the logs for the error/)).toBeTruthy();

    expect(screen.getByText("1 of 1 connection affected")).toBeTruthy();
    expect(screen.getByText("exit code 1")).toBeTruthy();

    expect(screen.getByRole("button", { name: "View logs" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Edit configuration" }),
    ).toBeTruthy();
  });

  it("explains every kind in the viewer's bucket, not only the worst one", () => {
    renderWithQuery(
      <McpServerIssueNotice
        variant="row"
        item={item}
        issues={[
          failedToStart("exit code 1"),
          {
            kind: "reinstall-required",
            severity: "attention",
            audience: "you",
            catalogId: "cat-1",
            serverId: "srv-1",
            detail: "Configuration changed since this was installed",
            since: null,
            muted: false,
            mutedReason: null,
          },
        ]}
        servers={[server]}
      />,
    );

    expect(screen.getByText("Failed to start")).toBeTruthy();
    expect(screen.getByText("Reinstall required")).toBeTruthy();
    expect(
      screen.getByText("Configuration changed since this was installed"),
    ).toBeTruthy();
  });

  it("names who can act instead of showing a button the viewer cannot press", () => {
    renderWithQuery(
      <McpServerIssueNotice
        variant="row"
        item={item}
        issues={[needsReauth({ audience: "others" })]}
        servers={[server]}
      />,
    );

    expect(
      screen.getByText(
        "Only the person who owns this connection can sign in to the provider again.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Re-authenticate" }),
    ).toBeNull();
    expect(screen.getByRole("link", { name: "Open" })).toBeTruthy();
  });

  it("keeps a muted alert visible, and says it is muted", () => {
    renderWithQuery(
      <McpServerIssueNotice
        variant="row"
        item={item}
        issues={[needsReauth({ muted: true })]}
        servers={[server]}
      />,
    );

    expect(screen.getByText("Needs re-authentication")).toBeTruthy();
    expect(
      screen.getByText("You muted this alert, so it is not counted for you."),
    ).toBeTruthy();
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
