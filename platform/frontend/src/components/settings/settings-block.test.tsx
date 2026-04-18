import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SettingsCardHeader } from "./settings-block";

describe("SettingsCardHeader", () => {
  it("adds spacing between the title and description", () => {
    const { container } = render(
      <SettingsCardHeader
        title="Default model"
        description="Pick the model used by default."
      />,
    );

    expect(container.querySelector(".space-y-1\\.5")).toBeTruthy();
    expect(screen.getByText("Pick the model used by default.")).toBeVisible();
  });

  it("vertically centers the action area", () => {
    const { container } = render(
      <SettingsCardHeader
        title="Default model"
        description="Pick the model used by default."
        action={<button type="button">Reset</button>}
      />,
    );

    expect(container.querySelector(".items-center")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reset" })).toBeVisible();
  });
});
