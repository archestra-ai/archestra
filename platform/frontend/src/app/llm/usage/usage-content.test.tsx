import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { makeUsageData } from "./usage.test-data";
import { UsageContent } from "./usage-content";

describe("usage exploration", () => {
  it("changes from model totals to a real time pivot and falls back when switching to clients", async () => {
    const user = userEvent.setup();
    render(<UsageContent {...makeUsageData()} />);
    expect(screen.getByRole("button", { name: /^pivot$/i })).toBeDisabled();
    await user.click(
      screen.getByRole("button", { name: "Activity over time" }),
    );
    await user.click(screen.getByRole("button", { name: /^pivot$/i }));
    const table = screen.getByRole("table");
    expect(within(table).getAllByText("3")).toHaveLength(4);
    expect(within(table).queryByText("example-model")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Usage by client" }));
    expect(screen.getByRole("button", { name: /^pivot$/i })).toBeDisabled();
    expect(
      within(screen.getByRole("table")).getByText("Not reported"),
    ).toBeInTheDocument();
  });
  it("keeps token mix and context in the explorer and lets a billed tile leave a non-billing grouping", async () => {
    const user = userEvent.setup();
    render(<UsageContent {...makeUsageData()} />);
    await user.click(screen.getByRole("button", { name: "Token mix" }));
    expect(
      within(screen.getByRole("table")).getByText("Cache writes"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Context size" }));
    expect(
      within(screen.getByRole("table")).getByText("Under 32K"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Billed spend \$/ }));
    expect(
      screen.getByRole("button", { name: "by Model" }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("table")).getByText("example-model"),
    ).toBeInTheDocument();
  });
  it("exports the input/output pivot rather than unrelated summary columns", async () => {
    const user = userEvent.setup();
    const write = vi.spyOn(navigator.clipboard, "writeText");
    render(<UsageContent {...makeUsageData()} />);
    await user.click(screen.getByRole("button", { name: /^Tokens / }));
    await user.click(screen.getByRole("button", { name: "split by None" }));
    await user.click(screen.getByRole("menuitem", { name: "Input / output" }));
    await user.click(screen.getByRole("button", { name: /^pivot$/i }));
    await user.click(screen.getByRole("button", { name: "Copy as CSV" }));
    expect(write).toHaveBeenCalledWith(
      "Model,Input,Output,total\nexample-model,80,20,100",
    );
  });
});
