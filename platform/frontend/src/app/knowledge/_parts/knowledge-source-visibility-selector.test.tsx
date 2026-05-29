import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { KnowledgeSourceVisibilitySelector } from "./knowledge-source-visibility-selector";

vi.mock("@/lib/config/config.query", () => ({
  useEnterpriseFeature: () => true,
}));

vi.mock("@/lib/teams/team.query", () => ({
  useTeams: () => ({ data: [] }),
}));

describe("KnowledgeSourceVisibilitySelector", () => {
  it("shows auto-sync permission details in the visibility option description", async () => {
    const user = userEvent.setup();

    render(
      <KnowledgeSourceVisibilitySelector
        visibility="org-wide"
        onVisibilityChange={vi.fn()}
        teamIds={[]}
        onTeamIdsChange={vi.fn()}
        connectorType="jira"
      />,
    );

    await user.click(screen.getByRole("button", { name: /Organization/i }));

    expect(
      screen.getByRole("button", {
        name: /Auto-sync permissions Each document inherits access from its source; users only see results they can already read upstream/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Available for Jira and Confluence today/i),
    ).not.toBeInTheDocument();
  });
});
