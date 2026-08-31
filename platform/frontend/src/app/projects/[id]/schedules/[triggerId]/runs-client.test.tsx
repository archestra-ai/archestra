import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useParams, usePathname, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { runNowMutate } = vi.hoisted(() => ({ runNowMutate: vi.fn() }));

vi.mock("next/navigation");

vi.mock("@/lib/hooks/use-app-name", () => ({
  useAppName: () => "Archestra",
}));

vi.mock("@/components/scheduled-tasks/schedule-runs-list", () => ({
  ScheduleRunsList: () => <div>Schedule runs</div>,
}));

vi.mock("@/lib/projects/projects.query", () => ({
  useProject: vi.fn(),
}));

vi.mock("@/lib/schedule-trigger.query", () => ({
  useRunScheduleTriggerNow: vi.fn(),
  useScheduleTrigger: vi.fn(),
}));

import { useProject } from "@/lib/projects/projects.query";
import {
  useRunScheduleTriggerNow,
  useScheduleTrigger,
} from "@/lib/schedule-trigger.query";
import { ProjectScheduleRunsClient } from "./runs-client";

describe("ProjectScheduleRunsClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useParams).mockReturnValue({
      id: "project-1",
      triggerId: "trigger-1",
    });
    vi.mocked(usePathname).mockReturnValue(
      "/projects/project-1/schedules/trigger-1/runs",
    );
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as ReturnType<typeof useSearchParams>,
    );
    vi.mocked(useProject).mockReturnValue({
      data: { name: "Roadmap" },
    } as ReturnType<typeof useProject>);
    vi.mocked(useScheduleTrigger).mockReturnValue({
      data: {
        name: "Daily report",
        cronExpression: "0 9 * * *",
        timezone: "UTC",
        agent: { name: "Reporter" },
      },
      isLoading: false,
    } as ReturnType<typeof useScheduleTrigger>);
    vi.mocked(useRunScheduleTriggerNow).mockReturnValue({
      mutate: runNowMutate,
      isPending: false,
    } as unknown as ReturnType<typeof useRunScheduleTriggerNow>);
  });

  it("keeps the schedule context visible and runs the current schedule", async () => {
    const user = userEvent.setup();

    render(<ProjectScheduleRunsClient />);

    expect(
      screen.getByRole("heading", { name: "Daily report — Runs" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Reporter · At 09:00 · UTC")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Roadmap" })).toHaveAttribute(
      "href",
      "/projects/project-1",
    );

    await user.click(screen.getByRole("button", { name: "Run now" }));

    expect(runNowMutate).toHaveBeenCalledWith("trigger-1");
  });
});
