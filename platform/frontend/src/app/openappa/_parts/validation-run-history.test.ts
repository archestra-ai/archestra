import { describe, expect, test } from "vitest";
import {
  validationRunBars,
  validationRunStatus,
} from "./validation-run-history";

const run = (
  id: string,
  statuses: ("passed" | "failed" | "cannot_run")[],
  extra: { executionError?: string; valid?: boolean } = {},
) => ({
  id,
  createdAt: `2026-10-0${id}T00:00:00.000Z`,
  executionError: extra.executionError ?? null,
  validation: { valid: extra.valid ?? true },
  files: statuses.map((status) => ({ status })),
});

describe("validationRunStatus", () => {
  test.each([
    { files: ["passed", "passed"], expected: "passed" },
    { files: ["passed", "failed", "cannot_run"], expected: "failed" },
    { files: ["passed", "cannot_run"], expected: "cannot_run" },
    { files: [], expected: "cannot_run" },
  ] as const)("$files → $expected", ({ files, expected }) => {
    expect(validationRunStatus(run("1", [...files]))).toBe(expected);
  });

  test("an execution error or invalid policy cannot run, whatever the files say", () => {
    expect(
      validationRunStatus(run("1", ["passed"], { executionError: "boom" })),
    ).toBe("cannot_run");
    expect(validationRunStatus(run("1", ["passed"], { valid: false }))).toBe(
      "cannot_run",
    );
  });
});

describe("validationRunBars", () => {
  test("counts each status per run and puts the oldest run first", () => {
    const bars = validationRunBars([
      run("2", ["passed", "failed", "failed"]),
      run("1", ["passed", "cannot_run"]),
    ]);
    expect(bars.map((bar) => bar.id)).toEqual(["1", "2"]);
    expect(bars[1]).toMatchObject({
      passed: 1,
      failed: 2,
      cannotRun: 0,
      total: 3,
    });
    expect(bars[0]).toMatchObject({
      passed: 1,
      failed: 0,
      cannotRun: 1,
      total: 2,
    });
  });

  test("a run that could not start keeps one visible cannot-run unit", () => {
    expect(
      validationRunBars([run("1", [], { executionError: "boom" })])[0],
    ).toMatchObject({ passed: 0, failed: 0, cannotRun: 1, total: 1 });
  });
});
