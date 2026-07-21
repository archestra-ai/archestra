// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppName } from "@/lib/hooks/use-app-name";
import { ConnectorUnassignedUsersAlert } from "./connector-unassigned-users-alert";

const mockUseConnectorUserGroups = vi.fn();

vi.mock("@/lib/knowledge/connector.query", () => ({
  useConnectorUserGroups: (args: unknown) => mockUseConnectorUserGroups(args),
}));

vi.mock("@/lib/hooks/use-app-name");

function mockGroups(
  members: Array<{
    accountId: string;
    displayName: string | null;
    email: string | null;
    accountType: string | null;
    user: { id: string; name: string } | null;
    resolvedVia: "override" | "email" | null;
  }>,
) {
  mockUseConnectorUserGroups.mockReturnValue({
    data: {
      groups: [
        {
          groupId: "engineers",
          token: "group:jira_engineers",
          documentCount: 128,
          lastSyncedAt: "2026-07-08T15:00:00.000Z",
          members,
        },
      ],
    },
    isPending: false,
    isError: false,
  });
}

beforeEach(() => {
  vi.mocked(useAppName).mockReturnValue("Archestra");
});

describe("ConnectorUnassignedUsersAlert", () => {
  it("diagnoses hidden-email users with the credential fix and the manual-assignment escape hatch", () => {
    mockGroups([
      {
        accountId: "acc-erin",
        displayName: "Erin E",
        email: null,
        accountType: null,
        user: null,
        resolvedVia: null,
      },
      // App accounts never count as unassigned humans.
      {
        accountId: "acc-bot",
        displayName: "Automation for Jira",
        email: null,
        accountType: "app",
        user: null,
        resolvedVia: null,
      },
    ]);

    render(
      <ConnectorUnassignedUsersAlert
        connectorId="connector-1"
        connectorType="jira"
      />,
    );

    expect(
      screen.getByText(
        /1 user is unassigned and can't access connector's documents/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Jira hides user emails from connector credentials/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Atlassian organization admin API key/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/assign Jira users to Archestra users manually/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Learn more" }),
    ).toBeInTheDocument();
  });

  it("suggests the invite path for users with a visible email but no account", () => {
    mockGroups([
      {
        accountId: "acc-bob",
        displayName: "Bob B",
        email: "bob@example.com",
        accountType: "atlassian",
        user: null,
        resolvedVia: null,
      },
    ]);

    render(
      <ConnectorUnassignedUsersAlert
        connectorId="connector-1"
        connectorType="jira"
      />,
    );

    expect(
      screen.getByText(/invite them with the same email/),
    ).toBeInTheDocument();
    // No hidden-email users, so the credential fix is omitted.
    expect(screen.queryByText(/hides user emails/)).not.toBeInTheDocument();
  });

  it("renders nothing when every user resolves", () => {
    mockGroups([
      {
        accountId: "acc-alice",
        displayName: "Alice A",
        email: "alice@example.com",
        accountType: "atlassian",
        user: { id: "user-1", name: "Alice" },
        resolvedVia: "email",
      },
    ]);

    const { container } = render(
      <ConnectorUnassignedUsersAlert
        connectorId="connector-1"
        connectorType="jira"
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
