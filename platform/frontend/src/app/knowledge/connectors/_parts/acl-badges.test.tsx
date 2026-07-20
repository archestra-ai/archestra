// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTeams } from "@/lib/teams/team.query";
import { AclBadges } from "./acl-badges";

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

  it("shows only the first two entries and collapses the rest behind +N more", () => {
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
    expect(screen.getByText("a@example.com")).toBeInTheDocument();
    expect(screen.getByText("+3 more")).toBeInTheDocument();
    // Hidden entries stay discoverable in the overflow tooltip.
    expect(screen.getByText("b@example.com")).toBeInTheDocument();
    expect(screen.getByText("Group: jira_engineers")).toBeInTheDocument();
    expect(screen.getByText("Group: jira_admins")).toBeInTheDocument();
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
