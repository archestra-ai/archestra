import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DateTimePicker } from "./date-time-picker";

// Mock ResizeObserver as a proper class (required by floating-ui/Radix Popover)
class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

describe("DateTimePicker", () => {
  describe("rendering", () => {
    it("renders the default placeholder when no value is provided", () => {
      render(<DateTimePicker value={undefined} onChange={vi.fn()} />);

      expect(
        screen.getByRole("button", { name: /Pick date and time/i }),
      ).toBeInTheDocument();
    });

    it("renders a formatted date when value is provided", () => {
      const date = new Date(2025, 5, 15, 14, 30); // June 15, 2025 14:30
      render(<DateTimePicker value={date} onChange={vi.fn()} />);

      expect(
        screen.getByRole("button", { name: /06\/15\/2025 14:30/ }),
      ).toBeInTheDocument();
    });

    it("renders custom placeholder text", () => {
      render(
        <DateTimePicker
          value={undefined}
          onChange={vi.fn()}
          placeholder="Select a date"
        />,
      );

      expect(
        screen.getByRole("button", { name: /Select a date/i }),
      ).toBeInTheDocument();
    });
  });

  describe("time selection", () => {
    it("calls onChange with updated hours when clicking an hour button", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      const date = new Date(2025, 5, 15, 10, 30); // June 15, 2025 10:30

      render(<DateTimePicker value={date} onChange={onChange} />);

      // Open the popover
      await user.click(screen.getByRole("button", { name: /06\/15\/2025/ }));

      // Click the "14" hour button
      const hourButton = screen.getByRole("button", { name: "14" });
      await user.click(hourButton);

      expect(onChange).toHaveBeenCalledTimes(1);
      const newDate = onChange.mock.calls[0][0] as Date;
      expect(newDate.getHours()).toBe(14);
      // Minutes should be preserved from the original value
      expect(newDate.getMinutes()).toBe(30);
    });

    it("calls onChange with updated minutes when clicking a minute button", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      const date = new Date(2025, 5, 15, 10, 30); // June 15, 2025 10:30

      render(<DateTimePicker value={date} onChange={onChange} />);

      // Open the popover
      await user.click(screen.getByRole("button", { name: /06\/15\/2025/ }));

      // Click the "45" minute button
      const minuteButton = screen.getByRole("button", { name: "45" });
      await user.click(minuteButton);

      expect(onChange).toHaveBeenCalledTimes(1);
      const newDate = onChange.mock.calls[0][0] as Date;
      expect(newDate.getMinutes()).toBe(45);
      // Hours should be preserved from the original value
      expect(newDate.getHours()).toBe(10);
    });

    it("uses current date with zeroed minutes as base when no value and an hour is clicked", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();

      render(<DateTimePicker value={undefined} onChange={onChange} />);

      // Open the popover
      await user.click(
        screen.getByRole("button", { name: /Pick date and time/i }),
      );

      // Click the "08" hour button
      const hourButton = screen.getByRole("button", { name: "08" });
      await user.click(hourButton);

      expect(onChange).toHaveBeenCalledTimes(1);
      const newDate = onChange.mock.calls[0][0] as Date;
      expect(newDate.getHours()).toBe(8);
      // Minutes should default to 0 when no existing value
      expect(newDate.getMinutes()).toBe(0);
    });
  });

  describe("date selection", () => {
    it("preserves existing time when selecting a new date", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      // Jan 15, 2025 at 14:30
      const date = new Date(2025, 0, 15, 14, 30);

      render(<DateTimePicker value={date} onChange={onChange} />);

      // Open the popover
      await user.click(screen.getByRole("button", { name: /01\/15\/2025/ }));

      // Click a different day in the calendar (day 20)
      const dayButton = screen.getByRole("gridcell", { name: "20" }).firstChild;
      if (dayButton) {
        await user.click(dayButton as Element);
      }

      expect(onChange).toHaveBeenCalledTimes(1);
      const newDate = onChange.mock.calls[0][0] as Date;
      expect(newDate.getDate()).toBe(20);
      // Time should be preserved
      expect(newDate.getHours()).toBe(14);
      expect(newDate.getMinutes()).toBe(30);
    });
  });

  describe("handleContainerScroll", () => {
    it("adjusts scrollTop based on wheel deltaY", async () => {
      const user = userEvent.setup();
      const date = new Date(2025, 0, 15, 10, 0);

      const { container } = render(
        <DateTimePicker value={date} onChange={vi.fn()} />,
      );

      // Open the popover
      await user.click(screen.getByRole("button", { name: /01\/15\/2025/ }));

      // Find the scrollable containers (hours and minutes) rendered in the popover portal
      const scrollContainers =
        container.ownerDocument.querySelectorAll<HTMLDivElement>(
          "[class*='overflow-y-auto']",
        );

      // There should be the hour and minute containers
      expect(scrollContainers.length).toBeGreaterThanOrEqual(2);

      const hourContainer = scrollContainers[0];

      // Define a writable scrollTop so we can observe changes
      Object.defineProperty(hourContainer, "scrollTop", {
        value: 0,
        writable: true,
      });

      // Fire a wheel event - the onWheel handler sets scrollTop += deltaY
      fireEvent.wheel(hourContainer, { deltaY: 50 });

      expect(hourContainer.scrollTop).toBe(50);
    });
  });
});
