import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CustomDateTimeRangeDialog } from "./custom-date-time-range-dialog";

const START = new Date(2026, 6, 1, 9, 0);

const renderDialog = (endDate: Date | undefined) =>
  render(
    <CustomDateTimeRangeDialog
      open
      onOpenChange={vi.fn()}
      startDate={START}
      endDate={endDate}
      onStartDateChange={vi.fn()}
      onEndDateChange={vi.fn()}
      onApply={vi.fn()}
    />,
  );

const applyButton = (result: ReturnType<typeof renderDialog>) =>
  result.getByRole("button", { name: "Apply" }) as HTMLButtonElement;

describe("CustomDateTimeRangeDialog", () => {
  it("allows applying a range that ends after it starts", () => {
    expect(applyButton(renderDialog(new Date(2026, 6, 2, 9, 0))).disabled).toBe(
      false,
    );
  });

  // None of these describes a window, so there is nothing to apply.
  it.each([
    ["ends before it starts", new Date(2026, 5, 1, 9, 0)],
    ["is zero-length", new Date(2026, 6, 1, 9, 0)],
    ["has no end", undefined],
  ])("blocks applying a range that %s", (_case, endDate) => {
    expect(applyButton(renderDialog(endDate)).disabled).toBe(true);
  });
});
