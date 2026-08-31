import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WizardStepper } from "./wizard-stepper";

const steps = [
  { id: "configuration", title: "Configuration" },
  { id: "tools", title: "Tools & Knowledge" },
  { id: "advanced", title: "Advanced" },
] as const;

describe("WizardStepper", () => {
  it("keeps the active step visible in a compact page header", () => {
    render(
      <WizardStepper
        compact
        steps={steps}
        activeStep="tools"
        onStepClick={() => {}}
      />,
    );

    expect(screen.getByText("Tools & Knowledge")).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: "Step 1 of 3: Configuration, complete",
      }),
    ).toHaveAttribute("title", "Configuration");
    expect(
      screen.getByRole("button", {
        name: "Step 3 of 3: Advanced, upcoming",
      }),
    ).toHaveAttribute("title", "Advanced");
    expect(
      document.querySelectorAll('[data-step-connector-state="complete"]'),
    ).toHaveLength(1);
    expect(
      document.querySelectorAll('[data-step-connector-state="upcoming"]'),
    ).toHaveLength(1);
    for (const connector of document.querySelectorAll(
      "[data-step-connector-state]",
    )) {
      expect(connector.querySelector("svg")).not.toBeNull();
    }
  });
});
