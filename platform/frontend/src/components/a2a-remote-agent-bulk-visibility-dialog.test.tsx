import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { A2aRemoteAgent } from "@/lib/a2a-remote-agents.query";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useOrganizationMembers } from "@/lib/organization.query";
import { useTeams } from "@/lib/teams/team.query";
import { A2aBulkVisibilityDialog } from "./a2a-remote-agent-bulk-visibility-dialog";

global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/organization.query");
vi.mock("@/lib/teams/team.query");
vi.mock("sonner");

const personalAgent = {
  id: "personal-agent",
  name: "Personal Agent",
  scope: "personal",
  teams: [],
  users: [],
} as unknown as A2aRemoteAgent;

const teamAgent = {
  id: "team-agent",
  name: "Team Agent",
  scope: "team",
  teams: [{ id: "team-1", name: "Finance" }],
  users: [],
} as unknown as A2aRemoteAgent;

beforeEach(() => {
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
    isPending: false,
  } as ReturnType<typeof useHasPermissions>);
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "user-1" } },
  } as ReturnType<typeof useSession>);
  vi.mocked(useTeams).mockReturnValue({
    data: [{ id: "team-1", name: "Finance" }],
  } as unknown as ReturnType<typeof useTeams>);
  vi.mocked(useOrganizationMembers).mockReturnValue({
    data: [],
  } as unknown as ReturnType<typeof useOrganizationMembers>);
});

describe("A2aBulkVisibilityDialog", () => {
  it("initializes from the current selection when a mounted dialog opens", async () => {
    const queryClient = new QueryClient();
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <A2aBulkVisibilityDialog
          agents={[personalAgent]}
          open={false}
          onOpenChange={() => {}}
          onComplete={() => {}}
        />
      </QueryClientProvider>,
    );

    rerender(
      <QueryClientProvider client={queryClient}>
        <A2aBulkVisibilityDialog
          agents={[teamAgent]}
          open
          onOpenChange={() => {}}
          onComplete={() => {}}
        />
      </QueryClientProvider>,
    );

    expect(await screen.findByRole("button", { name: /Teams/ })).toBeVisible();
  });

  it("defaults a mixed selection to personal visibility", async () => {
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <A2aBulkVisibilityDialog
          agents={[personalAgent, teamAgent]}
          open
          onOpenChange={() => {}}
          onComplete={() => {}}
        />
      </QueryClientProvider>,
    );

    expect(
      await screen.findByRole("button", { name: /Personal/ }),
    ).toBeVisible();
  });
});
