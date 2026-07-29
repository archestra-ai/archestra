import type { ResourceVisibilityScope } from "@archestra/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { SkillScopeSelector } from "./skill-scope-selector";

vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: () => ({ data: true }),
  useSession: () => ({ data: { user: { id: "me" } } }),
}));

vi.mock("@/lib/teams/team.query", () => ({
  useAssignableTeams: () => ({ data: [{ id: "team-1", name: "Platform" }] }),
}));

vi.mock("@/lib/organization.query", () => ({
  useOrganizationMembers: () => ({
    data: [
      { id: "me", name: "Me", email: "me@example.com" },
      { id: "other", name: "Ada Lovelace", email: "ada@example.com" },
    ],
  }),
}));

/**
 * The selector is controlled, so the real (scope, userIds) round trip through a
 * parent is what actually decides whether a choice sticks.
 */
function Harness({ initialUserIds = [] }: { initialUserIds?: string[] }) {
  const [scope, setScope] = useState<ResourceVisibilityScope>("personal");
  const [userIds, setUserIds] = useState<string[]>(initialUserIds);
  return (
    <SkillScopeSelector
      scope={scope}
      onScopeChange={setScope}
      teamIds={[]}
      onTeamIdsChange={() => {}}
      userIds={userIds}
      onUserIdsChange={setUserIds}
    />
  );
}

/** Opens the collapsed summary so the full option list is on screen. */
function expandOptions() {
  fireEvent.click(screen.getByText("Who can use this skill"));
  const summary = screen.getAllByRole("button")[0];
  fireEvent.click(summary);
}

describe("SkillScopeSelector", () => {
  it("keeps Users selected after it is picked, before anyone is named", () => {
    render(<Harness />);
    expandOptions();

    fireEvent.click(screen.getByText("Users"));

    // Sharing with named people is stored as `personal` plus grants, so an
    // empty selection would read back as plain Personal unless the choice is
    // held — which left the picker unreachable and the option uncheckable.
    expect(screen.queryByText("Only you can use this skill")).toBeNull();
    expect(screen.getByText("Share this with selected people")).not.toBeNull();
    expect(screen.getByText("Select users")).not.toBeNull();
  });

  it("shows Users already selected for a skill that has grants", () => {
    render(<Harness initialUserIds={["other"]} />);

    expect(screen.getByText("Share this with selected people")).not.toBeNull();
  });

  it("drops the pending Users choice when another scope is picked", () => {
    render(<Harness />);
    expandOptions();
    fireEvent.click(screen.getByText("Users"));

    const summary = screen.getAllByRole("button")[0];
    fireEvent.click(summary);
    fireEvent.click(screen.getByText("Organization"));

    expect(screen.queryByText("Select users")).toBeNull();
    expect(screen.queryByText("Share this with selected people")).toBeNull();
  });
});
