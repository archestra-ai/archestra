import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  SYNTHETIC_SCHEDULES,
  syntheticRuns,
} from "@/mocks/data/scheduled-runs";
import { ScheduleExecutionHistory } from "./schedule-execution-history";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it("separates years using the schedule timezone without repeating a year on every row", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
  const schedule = SYNTHETIC_SCHEDULES[0];
  const seed = syntheticRuns(schedule.id)[0];
  const runs = [
    { ...seed, id: "new-year", startedAt: "2026-01-01T06:00:00Z" },
    { ...seed, id: "old-year", startedAt: "2026-01-01T01:00:00Z" },
  ];
  render(
    <ScheduleExecutionHistory
      schedule={schedule}
      runs={runs}
      filter="all"
      onFilterChange={vi.fn()}
      onRetry={vi.fn()}
      loadingMore={false}
      hasNextPage={false}
      totalRuns={2}
      onLoadMore={vi.fn()}
      isLoading={false}
      isError={false}
      moreError={false}
    />,
  );
  expect(screen.getByRole("heading", { name: "2025" })).toBeInTheDocument();
  expect(
    screen.queryByRole("heading", { name: "2026" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: /Jan 1, 2026/ }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: /Dec 31, 2025/ }),
  ).toBeInTheDocument();
});
