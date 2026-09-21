import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePathname, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PageWizard } from "./page-wizard";

vi.mock("next/navigation");
vi.mock("@/lib/hooks/use-app-name", () => ({
  useAppName: () => "Archestra",
}));

const steps = [
  { id: "configuration", title: "Configuration" },
  { id: "access", title: "Access" },
] as const;

describe("PageWizard", () => {
  beforeEach(() => {
    vi.mocked(usePathname).mockReturnValue("/agents/new");
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as ReturnType<typeof useSearchParams>,
    );
  });

  it("renders the shared page frame and a compact stepper for multiple steps", () => {
    render(
      <PageWizard
        title="Create Agent"
        description="Configure the agent."
        backLink={<a href="/agents">Agents</a>}
        steps={steps}
        activeStep="access"
        stepTestIdPrefix="wizard-step"
      >
        <div>form content</div>
      </PageWizard>,
    );

    expect(
      screen.getByRole("heading", { level: 1, name: "Create Agent" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Configure the agent.")).toBeInTheDocument();
    expect(screen.getByText("form content")).toBeInTheDocument();
    expect(screen.getByTestId("wizard-step-access")).toHaveAttribute(
      "aria-current",
      "step",
    );
  });

  it("hides the stepper for a one-step form", () => {
    render(
      <PageWizard
        title="Connect agent"
        steps={[{ id: "connection", title: "Connection" }]}
        activeStep="connection"
      >
        <div>form content</div>
      </PageWizard>,
    );

    expect(screen.queryByRole("button", { name: /step 1 of 1/i })).toBeNull();
    expect(screen.getByText("form content")).toBeInTheDocument();
  });

  it("forwards revisitable step clicks", async () => {
    const user = userEvent.setup();
    const onStepClick = vi.fn();
    render(
      <PageWizard
        title="Create Agent"
        steps={steps}
        activeStep="access"
        onStepClick={onStepClick}
      >
        <div />
      </PageWizard>,
    );

    await user.click(screen.getByRole("button", { name: /configuration/i }));
    expect(onStepClick).toHaveBeenCalledWith("configuration");
  });
});
