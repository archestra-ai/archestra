import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useEnterpriseFeature, useFeature } from "@/lib/config/config.query";
import { useTeams } from "@/lib/teams/team.query";
import { KnowledgeSourceVisibilitySelector } from "./knowledge-source-visibility-selector";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query");
vi.mock("@/lib/teams/team.query");

function renderSelector(props: {
  visibility?: "org-wide" | "team-scoped" | "auto-sync-permissions";
  supportsAutoSync?: boolean;
}) {
  render(
    <KnowledgeSourceVisibilitySelector
      visibility={props.visibility ?? "org-wide"}
      onVisibilityChange={vi.fn()}
      teamIds={[]}
      onTeamIdsChange={vi.fn()}
      supportsAutoSync={props.supportsAutoSync ?? false}
      autoSyncPermissionAction="create"
    />,
  );
}

describe("KnowledgeSourceVisibilitySelector — auto-sync-permissions", () => {
  beforeEach(() => {
    vi.mocked(useTeams).mockReturnValue({
      data: [{ id: "team-1", name: "Team 1" }],
    } as ReturnType<typeof useTeams>);
    vi.mocked(useEnterpriseFeature).mockReturnValue(true);
    // Auto-sync is beta-gated; default the suite to the flag on.
    vi.mocked(useFeature).mockReturnValue(true);
    // Selecting auto-sync needs the knowledgeSourceAutoSync permission
    // (admin-only by default); default the suite to a permitted viewer.
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
    } as ReturnType<typeof useHasPermissions>);
  });

  // The selector renders collapsed; click the summary to reveal the options.
  function expandOptions() {
    fireEvent.click(screen.getByText("Organization"));
  }

  function autoSyncButton(): HTMLButtonElement {
    expandOptions();
    const label = screen.getByText("Auto-sync permissions");
    const button = label.closest("button");
    if (!button) throw new Error("Auto-sync option is not a button");
    return button;
  }

  it("offers the Auto-sync permissions option, enabled for a supported connector", () => {
    renderSelector({ supportsAutoSync: true });
    expect(autoSyncButton()).toBeEnabled();
  });

  it("hides the option entirely when the beta flag is off", () => {
    vi.mocked(useFeature).mockReturnValue(false);
    renderSelector({ supportsAutoSync: true });
    expandOptions();
    expect(screen.queryByText("Auto-sync permissions")).not.toBeInTheDocument();
  });

  it("still shows the option for a connector already using auto-sync when the flag is off", () => {
    vi.mocked(useFeature).mockReturnValue(false);
    renderSelector({
      visibility: "auto-sync-permissions",
      supportsAutoSync: true,
    });
    expect(screen.getByText("Auto-sync permissions")).toBeInTheDocument();
  });

  it("disables the option for a connector type that does not support it", () => {
    renderSelector({ supportsAutoSync: false });
    const button = autoSyncButton();
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent("Not supported for this source");
  });

  it("disables the option when the enterprise feature is off", () => {
    vi.mocked(useEnterpriseFeature).mockReturnValue(false);
    renderSelector({ supportsAutoSync: true });
    const button = autoSyncButton();
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent("Enterprise feature");
  });

  it("disables the option for a viewer without the auto-sync connectors permission", () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
    } as ReturnType<typeof useHasPermissions>);
    renderSelector({ supportsAutoSync: true });
    expect(vi.mocked(useHasPermissions)).toHaveBeenCalledWith({
      knowledgeSourceAutoSync: ["create"],
    });
    const button = autoSyncButton();
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent("Requires permission");
  });

  it("shows no team control when auto-sync is selected", () => {
    renderSelector({
      visibility: "auto-sync-permissions",
      supportsAutoSync: true,
    });
    expect(screen.queryByText("Teams")).not.toBeInTheDocument();
  });
});
