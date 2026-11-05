import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { LogTime } from "./log-time";

describe("LogTime", () => {
  it("omits duration for historical logs without timing", () => {
    render(<LogTime timestamp="2026-08-27T15:55:11Z" durationMs={null} />);
    expect(screen.queryByRole("img")).toBeNull();
  });

  it.each([
    { durationMs: 0, expected: "0ms" },
    { durationMs: 386, expected: "386ms" },
    { durationMs: 1240, expected: "1.24s" },
  ])("retains request timing including zero ($expected)", ({
    durationMs,
    expected,
  }) => {
    render(
      <LogTime timestamp="2026-08-27T15:55:11Z" durationMs={durationMs} />,
    );
    expect(
      screen.getByRole("img", { name: `Request duration: ${expected}` }),
    ).toBeVisible();
  });

  it("distinguishes a session span from request duration on focus", async () => {
    const user = userEvent.setup();
    render(<LogTime timestamp="2026-08-27T15:55:11Z" span="3m" />);
    expect(screen.getByRole("img", { name: "Session span: 3m" })).toBeVisible();
    await user.tab();
    expect(
      within(await screen.findByRole("tooltip")).getByText("Session span: 3m"),
    ).toBeInTheDocument();
  });
});
