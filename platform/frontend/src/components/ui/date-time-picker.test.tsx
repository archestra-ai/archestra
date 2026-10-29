import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DateTimePicker } from "./date-time-picker";

// Mock ResizeObserver as a proper class (required by floating-ui/Radix Popover)
class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

describe("DateTimePicker", () => {
  afterEach(() => vi.useRealTimers());

  describe("rendering", () => {
    it("names the field by its placeholder and shows the value as text", () => {
      const date = new Date(2025, 5, 15, 14, 30); // June 15, 2025 14:30
      render(
        <DateTimePicker
          value={date}
          onChange={vi.fn()}
          placeholder="Select a date"
        />,
      );

      expect(
        screen.getByRole("textbox", { name: "Select a date" }),
      ).toHaveValue("2025-06-15 14:30");
    });

    it("leaves the field empty without a value", () => {
      render(<DateTimePicker value={undefined} onChange={vi.fn()} />);

      expect(
        screen.getByRole("textbox", { name: "Pick date and time" }),
      ).toHaveValue("");
    });
  });

  describe("typing", () => {
    it("applies a typed date and time on Enter", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<DateTimePicker value={undefined} onChange={onChange} />);

      const field = screen.getByRole("textbox", { name: "Pick date and time" });
      await user.type(field, "2026-10-13 14:05{Enter}");

      expect(onChange).toHaveBeenCalledWith(new Date(2026, 9, 13, 14, 5));
    });

    it("applies a typed date when the field loses focus, at midnight without a time", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<DateTimePicker value={undefined} onChange={onChange} />);

      await user.type(
        screen.getByRole("textbox", { name: "Pick date and time" }),
        "2026-02-28",
      );
      await user.tab();

      expect(onChange).toHaveBeenCalledWith(new Date(2026, 1, 28, 0, 0));
    });

    it("reads now and now minus an amount", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 9, 13, 12, 0));
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<DateTimePicker value={undefined} onChange={onChange} />);
      const field = screen.getByRole("textbox", { name: "Pick date and time" });

      await user.type(field, "now-6h{Enter}");
      expect(onChange).toHaveBeenLastCalledWith(new Date(2026, 9, 13, 6, 0));

      await user.clear(field);
      await user.type(field, "now-7d{Enter}");
      expect(onChange).toHaveBeenLastCalledWith(new Date(2026, 9, 6, 12, 0));
    });

    it.each([
      ["text that names no date", "next tuesday"],
      ["a day the month does not have", "2026-02-31"],
    ])("marks %s invalid and keeps it for fixing", async (_case, text) => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<DateTimePicker value={undefined} onChange={onChange} />);
      const field = screen.getByRole("textbox", { name: "Pick date and time" });

      await user.type(field, `${text}{Enter}`);

      expect(onChange).not.toHaveBeenCalled();
      expect(field).toHaveAttribute("aria-invalid", "true");
      expect(field).toHaveValue(text);
    });

    it("rejects a typed date the calendar would disable", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(
        <DateTimePicker
          value={undefined}
          onChange={onChange}
          disabledDate={(date) => date < new Date(2026, 0, 1)}
        />,
      );
      const field = screen.getByRole("textbox", { name: "Pick date and time" });

      await user.type(field, "2025-12-31 10:00{Enter}");

      expect(onChange).not.toHaveBeenCalled();
      expect(field).toHaveAttribute("aria-invalid", "true");
    });

    it("clears the value when the text is erased", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(
        <DateTimePicker
          value={new Date(2026, 0, 1, 9, 0)}
          onChange={onChange}
        />,
      );
      const field = screen.getByRole("textbox", { name: "Pick date and time" });

      await user.clear(field);
      await user.tab();

      expect(onChange).toHaveBeenCalledWith(undefined);
    });
  });

  describe("calendar", () => {
    it("sets the time from the time field and keeps the day", () => {
      const onChange = vi.fn();
      render(
        <DateTimePicker
          value={new Date(2025, 5, 15, 10, 30)}
          onChange={onChange}
        />,
      );

      fireEvent.click(
        screen.getByRole("button", {
          name: "Open calendar: Pick date and time",
        }),
      );
      fireEvent.change(screen.getByLabelText("Time"), {
        target: { value: "14:05" },
      });

      expect(onChange).toHaveBeenCalledWith(new Date(2025, 5, 15, 14, 5));
    });

    it("gives a first picked day the current hour", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2025, 0, 10, 8, 42));
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<DateTimePicker value={undefined} onChange={onChange} />);

      await user.click(
        screen.getByRole("button", {
          name: "Open calendar: Pick date and time",
        }),
      );
      const dayButton = screen.getByRole("gridcell", { name: "20" }).firstChild;
      if (dayButton) await user.click(dayButton as Element);

      expect(onChange).toHaveBeenCalledWith(new Date(2025, 0, 20, 8, 0));
    });

    it("keeps the time when picking another day, and stays open until Done", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(
        <DateTimePicker
          value={new Date(2025, 0, 15, 14, 30)}
          onChange={onChange}
        />,
      );

      await user.click(
        screen.getByRole("button", {
          name: "Open calendar: Pick date and time",
        }),
      );
      const dayButton = screen.getByRole("gridcell", { name: "20" }).firstChild;
      if (dayButton) await user.click(dayButton as Element);

      expect(onChange).toHaveBeenCalledWith(new Date(2025, 0, 20, 14, 30));
      expect(screen.getByLabelText("Time")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Done" }));
      expect(screen.queryByLabelText("Time")).not.toBeInTheDocument();
    });
  });
});
