// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useOrganizationMembers } from "@/lib/organization.query";
import { ConnectorMembersTable } from "./connector-members-table";

const mockUseConnectorUserGroups = vi.fn();
const mockUpsertMutateAsync = vi.fn();
const mockDeleteMutateAsync = vi.fn();

vi.mock("@/lib/knowledge/connector.query", () => ({
  useConnectorUserGroups: (args: unknown) => mockUseConnectorUserGroups(args),
  useUpsertConnectorMemberOverride: () => ({
    mutateAsync: mockUpsertMutateAsync,
    isPending: false,
  }),
  useDeleteConnectorMemberOverride: () => ({
    mutateAsync: mockDeleteMutateAsync,
    isPending: false,
  }),
}));

vi.mock("next/navigation");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("@/lib/organization.query");

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
              resolvedVia: "email",
            },
            // Hidden email, manually assigned by an admin.
            {
              accountId: "acc-dave",
              displayName: "Dave D",
              email: null,
              accountType: null,
              user: { id: "user-2", name: "Dave" },
              resolvedVia: "override",
            },
            // Hidden email, unresolved — the actionable row.
            {
              accountId: "acc-erin",
              displayName: "Erin E",
              email: null,
              accountType: null,
              user: null,
              resolvedVia: null,
            },
            // Add-on/bot account: never resolvable, excluded from the table.
            {
              accountId: "acc-bot",
              displayName: "Automation for Jira",
              email: null,
              accountType: "app",
              user: null,
              resolvedVia: null,
            },
          ],
        },
        {
          groupId: "ops",
          token: "group:jira_ops",
          documentCount: 2,
          lastSyncedAt: null,
          members: [
            {
              accountId: "acc-alice",
              displayName: "Alice A",
              email: "alice@example.com",
              accountType: "atlassian",
              user: { id: "user-1", name: "Alice" },
              resolvedVia: "email",
            },
          ],
        },
      ],
    },
    isPending: false,
    isError: false,
  });
}

async function setupUserEvent() {
  // Radix Select relies on pointer-capture + scrollIntoView, which jsdom
  // does not implement.
  window.HTMLElement.prototype.hasPointerCapture = vi.fn();
  window.HTMLElement.prototype.setPointerCapture = vi.fn();
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  const { default: userEvent } = await import("@testing-library/user-event");
  return userEvent.setup();
}

beforeEach(() => {
  vi.mocked(useAppName).mockReturnValue("Archestra");
  vi.mocked(useOrganizationMembers).mockReturnValue({
    data: [
      { id: "user-1", name: "Alice", email: "alice@corp.com" },
      { id: "user-3", name: "Frank", email: "frank@corp.com" },
    ],
    isPending: false,
    // biome-ignore lint/suspicious/noExplicitAny: partial query result stub
  } as any);
  mockUpsertMutateAsync.mockResolvedValue({ success: true });
  mockDeleteMutateAsync.mockResolvedValue({ success: true });
});

describe("ConnectorMembersTable", () => {
  it("lists distinct human users with resolution state, unresolved first, bots excluded", () => {
    mockGroups();

    render(<ConnectorMembersTable connectorId="connector-1" />);

    // alice appears in two groups but is ONE row.
    expect(screen.getAllByText("Alice A")).toHaveLength(1);
    // External identity: upstream account id and email.
    expect(screen.getByText("acc-erin")).toBeInTheDocument();
    expect(screen.getByText("alice@example.com")).toBeInTheDocument();
    // Group memberships render as badges (one per group the user is in).
    expect(screen.getAllByText("engineers")).toHaveLength(3);
    expect(screen.getByText("ops")).toBeInTheDocument();
    // The resolved org user shows name over email (joined from org members).
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("alice@corp.com")).toBeInTheDocument();
    // The Assigned column distinguishes the three states.
    expect(screen.getByText("Dave")).toBeInTheDocument();
    expect(screen.getByText("Automatically")).toBeInTheDocument();
    expect(screen.getByText("Manually")).toBeInTheDocument();
    expect(screen.getByText("Unassigned")).toBeInTheDocument();
    // Default order: automatically assigned (Alice), manually assigned
    // (Dave), then unassigned (Erin).
    const rows = screen.getAllByRole("row");
    expect(rows[1]).toHaveTextContent("Alice A");
    expect(rows[2]).toHaveTextContent("Dave D");
    expect(rows[3]).toHaveTextContent("Erin E");
    // The bot never shows: it cannot sign in, so it cannot be mapped.
    expect(screen.queryByText("Automation for Jira")).not.toBeInTheDocument();
    // An email match cannot be overridden: Alice's action is disabled
    // (with the reason on hover), while the manually-assigned (Dave) and
    // unassigned (Erin) rows stay editable.
    expect(
      within(rows[1]).getByRole("button", { name: "Assign Archestra user" }),
    ).toBeDisabled();
    expect(
      screen.getByText(/Assigned automatically by email/),
    ).toBeInTheDocument();
    expect(
      within(rows[2]).getByRole("button", { name: "Assign Archestra user" }),
    ).toBeEnabled();
    expect(
      within(rows[3]).getByRole("button", { name: "Assign Archestra user" }),
    ).toBeEnabled();
  });

  it("assigns an unresolved user to an org user from the dialog", async () => {
    const user = await setupUserEvent();
    mockGroups();

    render(<ConnectorMembersTable connectorId="connector-1" />);

    // Erin (unassigned) sorts last, after the assigned users.
    const rows = screen.getAllByRole("row");
    await user.click(
      within(rows[3]).getByRole("button", { name: "Assign Archestra user" }),
    );
    expect(
      screen.getByText(/source hides this user's email/),
    ).toBeInTheDocument();
    // The dialog recaps the full external identity, not just the name.
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("acc-erin")).toBeInTheDocument();
    expect(within(dialog).getByText("Erin E")).toBeInTheDocument();
    expect(within(dialog).getByText("hidden")).toBeInTheDocument();

    // Nothing changed yet, so there is nothing to save.
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled();

    // The org-user picker is the app-standard searchable select (the
    // dialog's only combobox); it opens on the current state, "Unassigned".
    await user.click(within(dialog).getByRole("combobox"));
    await user.click(await screen.findByRole("button", { name: /Frank/ }));
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    expect(mockUpsertMutateAsync).toHaveBeenCalledWith({
      externalAccountId: "acc-erin",
      userId: "user-3",
    });
  });

  it("removes a manual assignment by picking the pinned Unassigned option", async () => {
    const user = await setupUserEvent();
    mockGroups();

    render(<ConnectorMembersTable connectorId="connector-1" />);

    // Dave (manually assigned) sorts between auto-assigned Alice and unassigned Erin.
    const rows = screen.getAllByRole("row");
    await user.click(
      within(rows[2]).getByRole("button", { name: "Assign Archestra user" }),
    );
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("combobox"));
    await user.click(await screen.findByRole("button", { name: "Unassigned" }));
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    expect(mockDeleteMutateAsync).toHaveBeenCalledWith("acc-dave");
  });

  it("filters users by group membership", async () => {
    const user = await setupUserEvent();
    mockGroups();

    render(<ConnectorMembersTable connectorId="connector-1" />);

    // Only alice is in "ops"; everyone is in "engineers".
    await user.click(screen.getByRole("combobox", { name: "Filter by group" }));
    await user.click(await screen.findByRole("option", { name: "ops" }));

    expect(screen.getByText("Alice A")).toBeInTheDocument();
    expect(screen.queryByText("Dave D")).not.toBeInTheDocument();
    expect(screen.queryByText("Erin E")).not.toBeInTheDocument();
  });

  it("filters to manually assigned users", async () => {
    const user = await setupUserEvent();
    mockGroups();

    render(<ConnectorMembersTable connectorId="connector-1" />);

    await user.click(screen.getByRole("combobox", { name: "Filter users" }));
    await user.click(
      await screen.findByRole("option", { name: "Manually assigned" }),
    );

    expect(screen.getByText("Dave D")).toBeInTheDocument();
    expect(screen.queryByText("Alice A")).not.toBeInTheDocument();
    expect(screen.queryByText("Erin E")).not.toBeInTheDocument();
  });
});
