import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  ScheduleTriggerPicker,
  type ScheduleTriggerPickerValue,
} from "./schedule-trigger-picker";

// Radix Select uses browser pointer-capture and scrolling APIs that jsdom omits.
Element.prototype.scrollIntoView = vi.fn();
Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
Element.prototype.setPointerCapture = vi.fn();
Element.prototype.releasePointerCapture = vi.fn();

const DEFAULT_VALUE: ScheduleTriggerPickerValue = {
  enabled: true,
  cronExpression: "0 9 * * 1-5",
  timezone: "UTC",
};

function renderPicker(overrides: Partial<ScheduleTriggerPickerValue> = {}) {
  const onChange = vi.fn();
  render(
    <ScheduleTriggerPicker
      value={{ ...DEFAULT_VALUE, ...overrides }}
      onChange={onChange}
    />,
  );
  return onChange;
}

async function chooseFrequency(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) {
  await user.click(screen.getByLabelText("Schedule"));
  await user.click(screen.getByRole("option", { name }));
}

describe("ScheduleTriggerPicker", () => {
  it.each([
    ["Manual", "manual"],
    ["Every hour", "hourly"],
    ["Every 6 hours", "6h"],
    ["Every 12 hours", "12h"],
    ["Daily", "daily"],
    ["Weekly", "weekly"],
    ["Custom cron", "custom"],
  ])("offers the %s frequency option", async (label) => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByLabelText("Schedule"));

    expect(screen.getByRole("option", { name: label })).toBeVisible();
  });

  it("shows only the controls that apply to the selected frequency", async () => {
    const user = userEvent.setup();
    renderPicker();

    expect(screen.getByText("At")).toBeInTheDocument();
    expect(screen.getByLabelText("Time")).toBeInTheDocument();
    expect(
      screen.getByRole("group", { name: "Days of week" }),
    ).toBeInTheDocument();

    await chooseFrequency(user, "Every hour");
    expect(screen.queryByLabelText("Time")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Timezone")).toBeInTheDocument();

    await chooseFrequency(user, "Weekly");
    expect(screen.getByLabelText("Day")).toBeInTheDocument();
    expect(screen.getByLabelText("Time")).toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: "Days of week" }),
    ).not.toBeInTheDocument();

    await chooseFrequency(user, "Custom cron");
    expect(screen.getByLabelText("Custom cron expression")).toBeInTheDocument();
    expect(screen.queryByLabelText("Time")).not.toBeInTheDocument();
  });

  it("rewrites the expression when the daily time changes", () => {
    const onChange = renderPicker();

    fireEvent.change(screen.getByLabelText("Time"), {
      target: { value: "14:00" },
    });

    expect(onChange).toHaveBeenLastCalledWith({
      enabled: true,
      cronExpression: "0 14 * * 1-5",
      timezone: "UTC",
    });
  });

  it("keeps one selected day when the last toggle is pressed", async () => {
    const user = userEvent.setup();
    const onChange = renderPicker({ cronExpression: "0 9 * * *" });
    const days = [
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ];

    for (const day of days) {
      await user.click(screen.getByRole("button", { name: day }));
    }
    const beforeLastToggle = onChange.mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Sunday" }));

    expect(screen.getByRole("button", { name: "Sunday" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(onChange).toHaveBeenCalledTimes(beforeLastToggle);
  });

  it("uses a compressed weekday range for the Weekdays shortcut", async () => {
    const user = userEvent.setup();
    const onChange = renderPicker({ cronExpression: "0 9 * * *" });

    await user.click(screen.getByRole("button", { name: "Weekdays" }));

    expect(onChange).toHaveBeenLastCalledWith({
      enabled: true,
      cronExpression: "0 9 * * 1-5",
      timezone: "UTC",
    });
  });

  it("defaults Daily to every day when enabling a manual trigger", async () => {
    const user = userEvent.setup();
    const onChange = renderPicker({
      enabled: false,
      cronExpression: "0 9 * * 1-5",
    });

    await chooseFrequency(user, "Daily");

    for (const day of [
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
      "Sunday",
    ]) {
      expect(screen.getByRole("button", { name: day })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    }
    expect(onChange).toHaveBeenLastCalledWith({
      enabled: true,
      cronExpression: "0 0 * * *",
      timezone: "UTC",
    });
  });

  it("preserves weekday-only schedules when editing an existing trigger", () => {
    renderPicker({
      enabled: true,
      cronExpression: "0 9 * * 1-5",
    });

    for (const day of [
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
    ]) {
      expect(screen.getByRole("button", { name: day })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    }
    for (const day of ["Saturday", "Sunday"]) {
      expect(screen.getByRole("button", { name: day })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    }
  });

  it("seeds Custom cron from the previous structured expression", async () => {
    const user = userEvent.setup();
    renderPicker({ cronExpression: "0 14 * * 1-5" });

    await chooseFrequency(user, "Custom cron");

    expect(screen.getByLabelText("Custom cron expression")).toHaveValue(
      "0 14 * * 1-5",
    );
  });

  it("reports invalid custom input and exposes the validation error", async () => {
    const user = userEvent.setup();
    const onChange = renderPicker();

    await chooseFrequency(user, "Custom cron");
    const input = screen.getByLabelText("Custom cron expression");
    await user.clear(input);
    await user.type(input, "0 14 * *");

    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription(
      "This is not a valid cron expression. Expected five fields: minute, hour, day of month, month, day of week.",
    );
    expect(
      screen.getByText(/This is not a valid cron expression/),
    ).toBeVisible();
    expect(onChange).toHaveBeenLastCalledWith({
      enabled: true,
      cronExpression: "0 14 * *",
      timezone: "UTC",
    });
  });

  it("shows the human-readable summary and next run preview", () => {
    renderPicker();

    expect(screen.getByText("At 09:00, Monday through Friday")).toBeVisible();
    expect(screen.getByText(/Next run/)).toBeVisible();
    expect(screen.getByText("0 9 * * 1-5")).toBeVisible();
  });
});
