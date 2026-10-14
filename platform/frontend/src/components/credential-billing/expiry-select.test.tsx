import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { ExpirySelect } from "./expiry-select";

function Harness() {
  const [value, setValue] = useState<Date | null>(
    new Date(Date.now() + 30 * 86400000),
  );
  return (
    <>
      <ExpirySelect value={value} onChange={setValue} />
      <output aria-label="Saved expiration">
        {value?.toISOString() ?? "never"}
      </output>
    </>
  );
}

describe("ExpirySelect", () => {
  it("switches between a custom date and presets without adding another field", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.getByRole("button", { name: "Expires" })).toHaveTextContent(
      "30 days",
    );
    await user.click(screen.getByRole("button", { name: "Expires" }));
    fireEvent.change(screen.getByLabelText("Time"), {
      target: { value: "13:45" },
    });
    expect(screen.getByLabelText("Saved expiration").textContent).toContain(
      ":45:00",
    );
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.getByRole("button", { name: "Expires" })).toHaveTextContent(
      "13:45",
    );
    expect(screen.queryByLabelText("Time")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Expires" }));
    await user.click(screen.getByRole("button", { name: "Never" }));
    expect(screen.getByLabelText("Saved expiration")).toHaveTextContent(
      "never",
    );
    await user.click(screen.getByRole("button", { name: "Expires" }));
    const before = Date.now();
    await user.click(screen.getByRole("button", { name: "7 days" }));
    const saved = new Date(
      screen.getByLabelText("Saved expiration").textContent ?? "",
    ).getTime();
    expect(saved - before).toBeGreaterThanOrEqual(7 * 86400000);
    expect(saved - before).toBeLessThan(7 * 86400000 + 1000);
  });
});
