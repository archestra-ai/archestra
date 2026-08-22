// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectorUserGroupsTable } from "./connector-user-groups-table";
import { WORKSPACE_ROSTER_NOUN } from "./roster-noun";

const mockUseConnectorUserGroups = vi.fn();

vi.mock("@/lib/knowledge/connector.query", () => ({
  useConnectorUserGroups: (args: unknown) => mockUseConnectorUserGroups(args),
}));

vi.mock("next/navigation");

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

function mockGroups() {
  mockUseConnectorUserGroups.mockReturnValue({
    data: {
      groups: [
        {
          groupId: "engineers",
          token: "group:jira_engineers",
          documentCount: 128,
          lastSyncedAt: "2026-07-08T15:00:00.000Z",
          members: [
            {
              accountId: "acc-alice",
              displayName: "Alice A",
              email: "alice@example.com",
              accountType: "atlassian",
              user: { id: "user-1", name: "Alice", email: "alice@example.com" },
            },
            {
              accountId: "acc-bob",
              displayName: "Bob B",
              email: "bob@example.com",
              accountType: "atlassian",
              user: null,
            },
            // Email hidden upstream: recorded, listed, fail-closed.
            {
              accountId: "acc-dave",
              displayName: "Dave D",
              email: null,
              accountType: null,
              user: null,
            },
            // Email hidden upstream but manually assigned: reads as the
            // mapped org user, exactly like an email-matched member.
            {
              accountId: "acc-erin",
              displayName: "Erin E",
              email: null,
              accountType: null,
              user: { id: "user-2", name: "Erin", email: "erin@example.com" },
              resolvedVia: "override",
            },
            // Add-on/bot account: no email BY NATURE — labeled as an app,
            // not counted as an unresolved human.
            {
              accountId: "acc-bot",
              displayName: "Automation for Jira",
              email: null,
              accountType: "app",
              user: null,
            },
          ],
        },
        {
          groupId: "ghosts",
          token: "group:jira_ghosts",
          documentCount: 3,
          lastSyncedAt: null,
          members: [],
        },
      ],
    },
    isPending: false,
    isError: false,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ConnectorUserGroupsTable", () => {
  it("summarizes each group's membership as assigned/total humans with the full list on hover", () => {
    mockGroups();

    render(<ConnectorUserGroupsTable connectorId="connector-1" />);

    expect(screen.getByText("engineers")).toBeInTheDocument();
    expect(screen.getByText("group:jira_engineers")).toBeInTheDocument();
    expect(screen.getByText("128")).toBeInTheDocument();
    // 4 human members of which alice (email) and erin (override) resolve;
    // the bot is an app account and stays out of the counts entirely.
    const rows = screen.getAllByRole("row");
    expect(rows[2]).toHaveTextContent("2/4 assigned");
    // The count's hover carries the member detail: resolved members with
    // their org user, unresolved with the reason.
    expect(screen.getByText("alice@example.com · Alice")).toBeInTheDocument();
    expect(screen.getByText("bob@example.com")).toBeInTheDocument();
    expect(screen.getByText("Dave D · email hidden")).toBeInTheDocument();
    // The manually assigned member shows the mapped user's identity, not
    // "email hidden".
    expect(screen.getByText("erin@example.com · Erin")).toBeInTheDocument();
    // App/bot accounts never appear — they cannot sign in.
    expect(
      screen.queryByText("Automation for Jira · app"),
    ).not.toBeInTheDocument();
    // A group granted on documents but with no snapshot members is called out.
    expect(screen.getByText("No resolvable members")).toBeInTheDocument();
  });

  it("shows a full assigned count when every member resolves", () => {
    mockUseConnectorUserGroups.mockReturnValue({
      data: {
        groups: [
          {
            groupId: "engineers",
            token: "group:jira_engineers",
            documentCount: 1,
            lastSyncedAt: "2026-07-08T15:00:00.000Z",
            members: [
              {
                accountId: "acc-alice",
                displayName: "Alice A",
                email: "alice@example.com",
                accountType: "atlassian",
                user: {
                  id: "user-1",
                  name: "Alice",
                  email: "alice@example.com",
                },
              },
            ],
          },
        ],
      },
      isPending: false,
      isError: false,
    });

    render(<ConnectorUserGroupsTable connectorId="connector-1" />);

    const rows = screen.getAllByRole("row");
    expect(rows[1]).toHaveTextContent("1/1 assigned");
  });

  it("sorts groups that gate documents nobody can reach to the top", () => {
    mockGroups();

    render(<ConnectorUserGroupsTable connectorId="connector-1" />);

    // "ghosts" gates 3 documents with zero resolvable members — highest
    // severity, above "engineers" despite its far larger document count.
    const rows = screen.getAllByRole("row");
    expect(rows[1]).toHaveTextContent("ghosts");
    expect(rows[2]).toHaveTextContent("engineers");
  });

  it("filters to fully assigned groups and reports when nothing matches", async () => {
    // Radix Select relies on pointer-capture + scrollIntoView, which jsdom
    // does not implement.
    window.HTMLElement.prototype.hasPointerCapture = vi.fn();
    window.HTMLElement.prototype.setPointerCapture = vi.fn();
    window.HTMLElement.prototype.releasePointerCapture = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    const { userEvent } = await import("@testing-library/user-event").then(
      (m) => ({ userEvent: m.default.setup() }),
    );
    mockGroups();

    render(<ConnectorUserGroupsTable connectorId="connector-1" />);

    // Neither group is fully assigned (engineers has unassigned members,
    // ghosts has no members at all).
    await userEvent.click(
      screen.getByRole("combobox", { name: "Filter groups" }),
    );
    await userEvent.click(
      await screen.findByRole("option", { name: "Fully assigned" }),
    );
    expect(
      screen.getByText("No groups match your search or filter."),
    ).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("combobox", { name: "Filter groups" }),
    );
    await userEvent.click(
      await screen.findByRole("option", { name: "Not fully assigned" }),
    );
    expect(screen.getByText("engineers")).toBeInTheDocument();
    expect(screen.getByText("ghosts")).toBeInTheDocument();
  });

  it("filters groups to those containing a selected member", async () => {
    window.HTMLElement.prototype.hasPointerCapture = vi.fn();
    window.HTMLElement.prototype.setPointerCapture = vi.fn();
    window.HTMLElement.prototype.releasePointerCapture = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    const { userEvent } = await import("@testing-library/user-event").then(
      (m) => ({ userEvent: m.default.setup() }),
    );
    mockGroups();

    render(<ConnectorUserGroupsTable connectorId="connector-1" />);

    // Bob is only in "engineers"; "ghosts" has no members.
    await userEvent.click(
      screen.getByRole("combobox", { name: "Filter by member" }),
    );
    // Resolved members are offered as the org user they resolve to — the
    // manual assignment (Erin) exactly like the email match (Alice) — and
    // never as their upstream identity; unresolved accounts keep it.
    expect(
      screen.getByRole("option", { name: "Alice (alice@example.com)" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Erin (erin@example.com)" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "Alice A" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "Erin E" }),
    ).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole("option", { name: "Bob B" }));
    expect(screen.getByText("engineers")).toBeInTheDocument();
    expect(screen.queryByText("ghosts")).not.toBeInTheDocument();
  });

  it("maps an org-user filter selection back to the upstream accounts that resolve to them", async () => {
    window.HTMLElement.prototype.hasPointerCapture = vi.fn();
    window.HTMLElement.prototype.setPointerCapture = vi.fn();
    window.HTMLElement.prototype.releasePointerCapture = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    const { userEvent } = await import("@testing-library/user-event").then(
      (m) => ({ userEvent: m.default.setup() }),
    );
    mockGroups();

    render(<ConnectorUserGroupsTable connectorId="connector-1" />);

    // Erin's upstream account (hidden email, manually assigned) is only in
    // "engineers": picking her org user finds it.
    await userEvent.click(
      screen.getByRole("combobox", { name: "Filter by member" }),
    );
    await userEvent.click(
      await screen.findByRole("option", { name: "Erin (erin@example.com)" }),
    );
    expect(screen.getByText("engineers")).toBeInTheDocument();
    expect(screen.queryByText("ghosts")).not.toBeInTheDocument();
  });

  it("searches across group names and member identities", () => {
    vi.useFakeTimers();
    mockGroups();

    render(<ConnectorUserGroupsTable connectorId="connector-1" />);

    // A member email finds the groups containing that member.
    fireEvent.change(
      screen.getByPlaceholderText("Search by group or member name"),
      { target: { value: "bob@example.com" } },
    );
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(screen.getByText("engineers")).toBeInTheDocument();
    expect(screen.queryByText("ghosts")).not.toBeInTheDocument();
  });

  it("shows an empty state before the first sync", () => {
    mockUseConnectorUserGroups.mockReturnValue({
      data: { groups: [] },
      isPending: false,
      isError: false,
    });

    render(<ConnectorUserGroupsTable connectorId="connector-1" />);

    expect(screen.getByText(/No user groups synced yet/)).toBeInTheDocument();
  });

  // Notion's group id is synthetic (`workspace-members-<workspaceId>`), so the
  // row shows the workspace id Notion itself reports — not the internal id.
  it("identifies a workspace row by the workspace id, not the synthetic group id", () => {
    mockUseConnectorUserGroups.mockReturnValue({
      data: {
        groups: [
          {
            groupId: "workspace-members-11111111-2222-3333-4444-555555555555",
            name: "Acme Inc",
            token:
              "group:notion_workspace-members-11111111-2222-3333-4444-555555555555",
            documentCount: 2,
            lastSyncedAt: "2026-07-08T15:00:00.000Z",
            members: [],
          },
        ],
      },
      isPending: false,
      isError: false,
    });

    render(
      <ConnectorUserGroupsTable
        connectorId="connector-1"
        noun={WORKSPACE_ROSTER_NOUN}
      />,
    );

    expect(screen.getByText("Acme Inc")).toBeInTheDocument();
    expect(
      screen.getByText("ID 11111111-2222-3333-4444-555555555555"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/workspace-members-/)).not.toBeInTheDocument();
  });

  // Notion's roster rows are workspaces, and the whole page family follows
  // the noun — column header, filters, and empty states included.
  it("renders workspace copy when given the workspace roster noun", () => {
    mockGroups();

    render(
      <ConnectorUserGroupsTable
        connectorId="connector-1"
        noun={WORKSPACE_ROSTER_NOUN}
      />,
    );

    expect(
      screen.getByRole("columnheader", { name: "Workspace" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("columnheader", { name: "Group" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("All workspaces")).toBeInTheDocument();

    mockUseConnectorUserGroups.mockReturnValue({
      data: { groups: [] },
      isPending: false,
      isError: false,
    });
    render(
      <ConnectorUserGroupsTable
        connectorId="connector-1"
        noun={WORKSPACE_ROSTER_NOUN}
      />,
    );
    expect(screen.getByText(/No workspaces synced yet/)).toBeInTheDocument();
  });
});
