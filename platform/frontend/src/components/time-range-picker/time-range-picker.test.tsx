import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { TimeRange } from "./time-range";
import { TimeRangePicker } from "./time-range-picker";

class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

describe("TimeRangePicker", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 13, 12, 0));
    window.localStorage.clear();
  });
  afterEach(() => vi.useRealTimers());

  it("applies a quick range in one click and names it on the button", async () => {
    const user = userEvent.setup();
    const onChange = renderPicker(null);

    await user.click(screen.getByRole("button", { name: /Any time/ }));
    await user.click(
      within(
        screen.getByRole("navigation", { name: "Quick ranges" }),
      ).getByRole("button", { name: "Last 24 hours" }),
    );

    expect(onChange).toHaveBeenLastCalledWith({ from: "now-24h", to: "now" });
    expect(
      screen.getByRole("button", { name: /Last 24 hours/ }),
    ).toBeInTheDocument();
  });

  it("finds quick ranges by search", async () => {
    const user = userEvent.setup();
    renderPicker(null);

    await user.click(screen.getByRole("button", { name: /Any time/ }));
    await user.type(
      screen.getByRole("searchbox", { name: "Search quick ranges" }),
      "days",
    );

    const ranges = within(
      screen.getByRole("navigation", { name: "Quick ranges" }),
    ).getAllByRole("button");
    expect(ranges.map((range) => range.textContent)).toEqual([
      "Last 2 days",
      "Last 7 days",
      "Last 30 days",
      "Last 90 days",
    ]);
  });

  it("applies a typed range and remembers it as recently used", async () => {
    const user = userEvent.setup();
    const onChange = renderPicker({ from: "now-6h", to: "now" });

    await user.click(screen.getByRole("button", { name: /Last 6 hours/ }));
    const from = screen.getByLabelText("From");
    await user.clear(from);
    await user.type(from, "2026-10-12 09:00");
    const to = screen.getByLabelText("To");
    await user.clear(to);
    await user.type(to, "2026-10-12 18:00{Enter}");

    const typed = { from: "2026-10-12 09:00", to: "2026-10-12 18:00" };
    expect(onChange).toHaveBeenLastCalledWith(typed);
    expect(
      screen.getByRole("button", { name: /Oct 12, 09:00 – 18:00/ }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Oct 12, 09:00/ }));
    expect(
      screen.getByRole("button", {
        name: "2026-10-12 09:00 → 2026-10-12 18:00",
      }),
    ).toBeInTheDocument();
  });

  it.each([
    ["an end it cannot read", "yesterday", "now", "From is not a date"],
    ["an end before the start", "now", "now-1h", "To must come after From"],
  ])("refuses %s", async (_case, fromText, toText, message) => {
    const user = userEvent.setup();
    const onChange = renderPicker({ from: "now-6h", to: "now" });

    await user.click(screen.getByRole("button", { name: /Last 6 hours/ }));
    await user.clear(screen.getByLabelText("From"));
    await user.type(screen.getByLabelText("From"), fromText);
    await user.clear(screen.getByLabelText("To"));
    await user.type(screen.getByLabelText("To"), `${toText}{Enter}`);

    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("moves the range a span earlier, and back no later than now", async () => {
    const user = userEvent.setup();
    const onChange = renderPicker({ from: "now-6h", to: "now" });

    expect(
      screen.getByRole("button", { name: "Move range later" }),
    ).toBeDisabled();
    await user.click(
      screen.getByRole("button", { name: "Move range earlier" }),
    );

    expect(onChange).toHaveBeenLastCalledWith({
      from: "2026-10-13 00:00",
      to: "2026-10-13 06:00",
    });
    await user.click(screen.getByRole("button", { name: "Move range later" }));
    expect(onChange).toHaveBeenLastCalledWith({
      from: "2026-10-13 06:00",
      to: "2026-10-13 12:00",
    });
  });

  it("resets the range from inside the picker where a page allows it", async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();
    renderPicker({ from: "now-6h", to: "now" }, { onClear });

    await user.click(screen.getByRole("button", { name: "Reset time range" }));

    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("offers All time only where a page asks for it", async () => {
    const user = userEvent.setup();
    renderPicker(null, { allowAllTime: true });

    await user.click(screen.getByRole("button", { name: /Any time/ }));
    await user.click(screen.getByRole("button", { name: "All time" }));

    expect(
      screen.getByRole("button", { name: /All time/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Zoom out time range" }),
    ).toBeDisabled();
  });
});

function renderPicker(
  initial: TimeRange | null,
  props: { allowAllTime?: boolean; onClear?: () => void } = {},
) {
  const onChange = vi.fn();
  function Harness() {
    const [value, setValue] = useState(initial);
    return (
      <TooltipProvider>
        <TimeRangePicker
          value={value}
          onChange={(range) => {
            onChange(range);
            setValue(range);
          }}
          {...props}
        />
      </TooltipProvider>
    );
  }
  render(<Harness />);
  return onChange;
}
