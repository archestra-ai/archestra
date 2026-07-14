// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectorUserGroupsTable } from "./connector-user-groups-table";

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
              user: { id: "user-1", name: "Alice" },
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
    // 3 human members of which only alice resolves; the bot is an app
    // account and stays out of the counts entirely.
    const rows = screen.getAllByRole("row");
    expect(rows[2]).toHaveTextContent("1/3 assigned");
    // The Members badges carry the member detail: resolved members with
    // their org user, unresolved with the reason, overflow in the tooltip.
    expect(screen.getByText("alice@example.com · Alice")).toBeInTheDocument();
    expect(screen.getByText("bob@example.com")).toBeInTheDocument();
    expect(screen.getByText("+1 more")).toBeInTheDocument();
    expect(screen.getByText("Dave D · email hidden")).toBeInTheDocument();
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
                user: { id: "user-1", name: "Alice" },
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
    await userEvent.click(await screen.findByRole("option", { name: "Bob B" }));
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
});
