import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { TeamSelect } from "./team-select";

global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = vi.fn();

const TEAMS = [
  { id: "t-support", name: "Customer Support", description: null, members: [] },
  {
    id: "t-data",
    name: "Data Science",
    description: "Forecasting",
    members: [{ userId: "u1" }, { userId: "u2" }],
  },
] as never[];

describe("TeamSelect", () => {
  it("selects the team that was clicked, below a pinned no-team choice", async () => {
    const user = userEvent.setup();
    const onValueChange = renderSelect(null);

    await user.click(screen.getByRole("combobox", { name: "Billing team" }));
    expect(
      screen.getByRole("option", { name: /^Data Science/ }),
    ).toHaveTextContent("2 members · Forecasting");
    await user.click(screen.getByRole("option", { name: /^Data Science/ }));

    expect(onValueChange).toHaveBeenLastCalledWith("t-data");
    expect(
      screen.getByRole("combobox", { name: "Billing team" }),
    ).toHaveTextContent("Data Science");
  });

  it("clears the team with the no-team choice", async () => {
    const user = userEvent.setup();
    const onValueChange = renderSelect("t-data");

    await user.click(screen.getByRole("combobox", { name: "Billing team" }));
    await user.click(screen.getByRole("option", { name: /^No team/ }));

    expect(onValueChange).toHaveBeenLastCalledWith(null);
  });
});

function renderSelect(initial: string | null) {
  const onValueChange = vi.fn();
  function Harness() {
    const [value, setValue] = useState(initial);
    return (
      <TeamSelect
        ariaLabel="Billing team"
        value={value}
        onValueChange={(next) => {
          onValueChange(next);
          setValue(next);
        }}
        teams={TEAMS}
        noneOption={{ label: "No team", description: "Nobody pays" }}
      />
    );
  }
  render(<Harness />);
  return onValueChange;
}
