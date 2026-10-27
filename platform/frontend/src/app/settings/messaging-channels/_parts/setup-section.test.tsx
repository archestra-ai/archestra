import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SetupSection } from "./setup-section";

function renderSection(props: {
  allStepsCompleted: boolean;
  isLoading: boolean;
}) {
  return render(
    <SetupSection
      allStepsCompleted={props.allStepsCompleted}
      isLoading={props.isLoading}
      providerLabel="Slack"
      docsUrl={null}
    >
      <div>step content</div>
    </SetupSection>,
  );
}

describe("SetupSection", () => {
  it("keeps completed setup steps visible without a disclosure control", () => {
    renderSection({ allStepsCompleted: true, isLoading: false });

    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.getByText("step content")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Show details" }),
    ).not.toBeInTheDocument();
  });

  it("shows incomplete setup steps without a completed badge", () => {
    renderSection({ allStepsCompleted: false, isLoading: false });

    expect(screen.getByText("step content")).toBeInTheDocument();
    expect(screen.queryByText("Completed")).not.toBeInTheDocument();
  });

  it("hides setup steps while their status is loading", () => {
    renderSection({ allStepsCompleted: false, isLoading: true });

    expect(screen.queryByText("step content")).not.toBeInTheDocument();
  });
});
