// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render as rtlRender, screen } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { useTeams } from "@/lib/teams/team.query";
import { AclBadges } from "./acl-badges";
import { WORKSPACE_ROSTER_NOUN } from "./roster-noun";

vi.mock("@/lib/teams/team.query");

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

describe("AclBadges", () => {
  beforeEach(() => {
    vi.mocked(useTeams).mockReturnValue({
      data: [{ id: "team-1", name: "Platform Team" }],
    } as unknown as ReturnType<typeof useTeams>);
  });

  it("renders an empty ACL as a locked warning", () => {
    render(<AclBadges acl={[]} />);
    expect(screen.getByText("Locked")).toBeInTheDocument();
    expect(
      screen.getByText(/access-restricted until a permission sync/),
    ).toBeInTheDocument();
  });

  it("resolves team tokens to team names", () => {
    render(<AclBadges acl={["team:team-1", "team:team-unknown"]} />);
    expect(screen.getByText("Team: Platform Team")).toBeInTheDocument();
    // Unknown team ids degrade to the raw id rather than hiding the grant.
    expect(screen.getByText("Team: team-unknown")).toBeInTheDocument();
  });

  it("shows only the first two entries and collapses the rest behind +N more", async () => {
    render(
      <AclBadges
        acl={[
          "org:*",
          "user_email:a@example.com",
          "user_email:b@example.com",
          "group:jira_engineers",
          "group:jira_admins",
        ]}
      />,
    );
    expect(screen.getByText("Everyone in org")).toBeInTheDocument();
    // A user grant that matches an org member reads as that user (a manual
    // member mapping materializes the mapped user's email here, so it
    // resolves identically).
    expect(
      await screen.findByText("a@example.com · Alice"),
    ).toBeInTheDocument();
    expect(screen.getByText("+3 more")).toBeInTheDocument();
    // Hidden entries stay discoverable in the overflow tooltip; an email
    // matching no org member degrades to the raw address.
    expect(screen.getByText("b@example.com")).toBeInTheDocument();
    expect(screen.getByText("Group: jira_engineers")).toBeInTheDocument();
    expect(screen.getByText("Group: jira_admins")).toBeInTheDocument();
  });

  it("names group grants after the roster row, in the connector's own noun", () => {
    render(
      <AclBadges
        acl={[
          "group:notion_workspace-members-ws-1",
          "group:notion_workspace-members-ws-unsynced",
        ]}
        groupNamesByToken={
          new Map([["group:notion_workspace-members-ws-1", "Acme Inc"]])
        }
        noun={WORKSPACE_ROSTER_NOUN}
      />,
    );
    expect(screen.getByText("Workspace: Acme Inc")).toBeInTheDocument();
    // A grant with no roster row yet still shows its group id — never nothing.
    expect(
      screen.getByText("Workspace: notion_workspace-members-ws-unsynced"),
    ).toBeInTheDocument();
  });

  it("collapses very large ACLs into +N more with every entry in the tooltip", () => {
    const acl = Array.from(
      { length: 1000 },
      (_, i) => `user_email:user${i}@example.com`,
    );
    render(<AclBadges acl={acl} />);
    // 2 visible + 998 behind the overflow badge…
    expect(screen.getByText("+998 more")).toBeInTheDocument();
    // …whose (scrollable) tooltip lists ALL collapsed entries.
    expect(screen.getByText("user17@example.com")).toBeInTheDocument();
    expect(screen.getByText("user999@example.com")).toBeInTheDocument();
  });
});

const memberServer = setupServer(
  http.get(
    "http://localhost:9000/api/organization/member-options",
    ({ request }) => {
      const emails = new URL(request.url).searchParams
        .get("emails")
        ?.split(",");
      expect(emails).toBeDefined();
      expect(emails?.length).toBeLessThanOrEqual(100);
      return HttpResponse.json({
        data: emails?.includes("a@example.com")
          ? [{ id: "user-1", name: "Alice", email: "a@example.com" }]
          : [],
        pagination: { limit: 100, hasNext: false, nextCursor: null },
      });
    },
  ),
);
const clients: QueryClient[] = [];
beforeAll(() => {
  archestraApiClient.setConfig({ baseUrl: "http://localhost:9000" });
  memberServer.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  for (const client of clients) client.clear();
  clients.length = 0;
  memberServer.resetHandlers();
});
afterAll(() => memberServer.close());
function render(element: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  return rtlRender(
    <QueryClientProvider client={client}>{element}</QueryClientProvider>,
  );
}
