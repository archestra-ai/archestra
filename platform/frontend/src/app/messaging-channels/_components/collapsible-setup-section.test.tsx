import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CollapsibleSetupSection } from "./collapsible-setup-section";

function renderSection(props: {
  allStepsCompleted: boolean;
  isLoading: boolean;
}) {
  return render(
    <CollapsibleSetupSection
      allStepsCompleted={props.allStepsCompleted}
      isLoading={props.isLoading}
      providerLabel="Slack"
      docsUrl={null}
    >
      <div>step content</div>
    </CollapsibleSetupSection>,
  );
}

describe("CollapsibleSetupSection", () => {
  // The expand/collapse state must be deterministic, not dependent on async
  // query settle order (the previous effect keyed off a null→false→true
  // transition, so a refetch could leave it open or collapsed at random).
  it("starts collapsed when setup is already complete on load", () => {
    renderSection({ allStepsCompleted: true, isLoading: false });
    expect(screen.getByText("Show details")).toBeInTheDocument();
    expect(screen.queryByText("Hide details")).not.toBeInTheDocument();
  });

  it("shows the steps (no collapse toggle) while setup is incomplete", () => {
    renderSection({ allStepsCompleted: false, isLoading: false });
    expect(screen.getByText("step content")).toBeInTheDocument();
    expect(screen.queryByText("Show details")).not.toBeInTheDocument();
    expect(screen.queryByText("Hide details")).not.toBeInTheDocument();
  });

  it("stays expanded when the last step completes while the user is viewing", () => {
    const { rerender } = renderSection({
      allStepsCompleted: false,
      isLoading: false,
    });
    rerender(
      <CollapsibleSetupSection
        allStepsCompleted
        isLoading={false}
        providerLabel="Slack"
        docsUrl={null}
      >
        <div>step content</div>
      </CollapsibleSetupSection>,
    );
    expect(screen.getByText("Hide details")).toBeInTheDocument();
  });
});
