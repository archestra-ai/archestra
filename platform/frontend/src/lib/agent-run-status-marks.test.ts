import { describe, expect, it } from "vitest";
import { runStatusMarks } from "./agent-run-status-marks";

const NOW = new Date("2026-09-18T12:00:00.000Z").getTime();
const minutesAgo = (minutes: number) =>
  new Date(NOW - minutes * 60_000).toISOString();
const live = {
  startedAt: minutesAgo(60),
  endedAt: null,
  hardDeadlineAt: new Date(NOW + 60 * 60_000).toISOString(),
  lastModelActivityAt: minutesAgo(1),
};

describe("runStatusMarks", () => {
  it.each([
    [
      "booting",
      { ...live, state: "TASK_STATE_SUBMITTED" },
      { glyph: "booting", dot: null, description: "Starting" },
    ],
    [
      "working on the turn",
      { ...live, state: "TASK_STATE_WORKING" },
      { glyph: "live", dot: "working", description: "Running" },
    ],
    [
      "waiting on you mid-turn",
      {
        ...live,
        state: "TASK_STATE_WORKING",
        attentionState: "input_required",
      },
      {
        glyph: "live",
        dot: "attention",
        description: "Running · Needs your input",
      },
    ],
    [
      "sign-in needed",
      { ...live, state: "TASK_STATE_WORKING", attentionState: "auth_required" },
      {
        glyph: "live",
        dot: "attention",
        description: "Running · Needs sign-in",
      },
    ],
    [
      "legacy input-required task state",
      { ...live, state: "TASK_STATE_INPUT_REQUIRED" },
      {
        glyph: "live",
        dot: "attention",
        description: "Running · Needs your input",
      },
    ],
    [
      "went quiet mid-turn",
      {
        ...live,
        state: "TASK_STATE_WORKING",
        lastModelActivityAt: minutesAgo(20),
      },
      { glyph: "live", dot: "working", description: "Running · quiet for 20m" },
    ],
    [
      "turn done, agent still working",
      {
        ...live,
        state: "TASK_STATE_COMPLETED",
        endedAt: minutesAgo(10),
        lastModelActivityAt: minutesAgo(1),
      },
      {
        glyph: "live",
        dot: "working",
        description: "Session active · turn completed",
      },
    ],
    [
      "turn done, CLI idle at its prompt",
      {
        ...live,
        state: "TASK_STATE_COMPLETED",
        endedAt: minutesAgo(10),
        lastModelActivityAt: minutesAgo(30),
        terminalRetained: true,
      },
      {
        glyph: "live",
        dot: null,
        description: "Session open · turn completed",
      },
    ],
    [
      "turn done, CLI exited",
      {
        ...live,
        state: "TASK_STATE_COMPLETED",
        endedAt: minutesAgo(10),
        lastModelActivityAt: minutesAgo(30),
        terminalRetained: false,
      },
      { glyph: "off", dot: null, description: "Completed" },
    ],
    [
      "workspace suspended",
      {
        ...live,
        state: "TASK_STATE_COMPLETED",
        endedAt: minutesAgo(10),
        lastModelActivityAt: minutesAgo(30),
        workspace: { state: "suspended" },
      },
      { glyph: "off", dot: null, description: "Completed · suspended" },
    ],
    [
      "turn failed",
      { ...live, state: "TASK_STATE_FAILED", endedAt: minutesAgo(1) },
      { glyph: "off", dot: "failed", description: "Ended · Failed" },
    ],
    [
      "turn rejected",
      { ...live, state: "TASK_STATE_REJECTED", endedAt: minutesAgo(1) },
      { glyph: "off", dot: "failed", description: "Ended · Failed" },
    ],
    [
      "canceled by you",
      { ...live, state: "TASK_STATE_CANCELED", endedAt: minutesAgo(1) },
      { glyph: "off", dot: null, description: "Canceled" },
    ],
    [
      "past hard deadline, still open",
      {
        ...live,
        state: "TASK_STATE_WORKING",
        hardDeadlineAt: minutesAgo(1),
      },
      { glyph: "off", dot: null, description: "Stopping" },
    ],
  ] as const)("%s", (_row, run, expected) => {
    expect(runStatusMarks(run, NOW)).toMatchObject(expected);
  });

  it("does not read a retained session as active once its model activity is stale", () => {
    expect(
      runStatusMarks(
        {
          state: "TASK_STATE_COMPLETED",
          endedAt: minutesAgo(40),
          lastModelActivityAt: minutesAgo(20),
        },
        NOW,
      ),
    ).toMatchObject({ glyph: "off", dot: null, description: "Completed" });
  });

  it("keeps the header words in step with the sidebar description", () => {
    const marks = runStatusMarks(
      { ...live, state: "TASK_STATE_WORKING", attentionState: "auth_required" },
      NOW,
    );
    expect(marks.label).toBe("Running");
    expect(marks.chip).toEqual({ tone: "attention", label: "Needs sign-in" });
    expect(marks.description).toBe("Running · Needs sign-in");
  });
});
