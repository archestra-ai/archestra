import { describe, expect, test } from "vitest";
import {
  validationFileStates,
  validationName,
  validationRunBars,
  validationRunStatus,
  validationSuiteSummary,
  validationSummaryText,
} from "./validation-run-history";

type Status = "passed" | "failed" | "cannot_run";

const run = (
  id: string,
  files: [path: string, hash: string, status: Status][],
  extra: {
    executionError?: string;
    valid?: boolean;
    partial?: boolean;
    errors?: string[];
  } = {},
) => ({
  id,
  createdAt: `2026-10-0${id}T00:00:00.000Z`,
  executionError: extra.executionError ?? null,
  partial: extra.partial,
  validation: { valid: extra.valid ?? true, errors: extra.errors ?? [] },
  files: files.map(([path, contentHash, status]) => ({
    path,
    contentHash,
    status,
  })),
});

describe("validationRunStatus", () => {
  test.each([
    { statuses: ["passed", "passed"], expected: "passed" },
    { statuses: ["passed", "failed", "cannot_run"], expected: "failed" },
    { statuses: ["passed", "cannot_run"], expected: "cannot_run" },
    { statuses: [], expected: "cannot_run" },
  ] as const)("$statuses → $expected", ({ statuses, expected }) => {
    expect(
      validationRunStatus(
        run(
          "1",
          statuses.map((status, i) => [`f${i}.appa`, "h", status] as const),
        ),
      ),
    ).toBe(expected);
  });

  test("an execution error or invalid policy cannot run, whatever the files say", () => {
    const files: [string, string, Status][] = [["a.appa", "h", "passed"]];
    expect(
      validationRunStatus(run("1", files, { executionError: "boom" })),
    ).toBe("cannot_run");
    expect(validationRunStatus(run("1", files, { valid: false }))).toBe(
      "cannot_run",
    );
  });
});

describe("validationRunBars", () => {
  test("counts each status per run and puts the oldest run first", () => {
    const bars = validationRunBars([
      run("2", [
        ["a", "h", "passed"],
        ["b", "h", "failed"],
        ["c", "h", "failed"],
      ]),
      run("1", [
        ["a", "h", "passed"],
        ["b", "h", "cannot_run"],
      ]),
    ]);
    expect(bars.map((bar) => bar.id)).toEqual(["1", "2"]);
    expect(bars[1]).toMatchObject({ passed: 1, failed: 2, cannotRun: 0 });
    expect(bars[0]).toMatchObject({ passed: 1, failed: 0, cannotRun: 1 });
  });

  test("a run that could not start keeps one visible cannot-run unit", () => {
    expect(
      validationRunBars([run("1", [], { executionError: "boom" })])[0],
    ).toMatchObject({ passed: 0, failed: 0, cannotRun: 1, total: 1 });
  });
});

describe("validationFileStates", () => {
  test("a file keeps its newest result after an edit, and is not run until it first runs", () => {
    const runs = [
      run("3", [["old.appa", "h-old", "passed"]]),
      run("2", [["a.appa", "h-a-v1", "failed"]]),
      run("1", [["a.appa", "h-a-v2", "passed"]]),
    ];
    const states = validationFileStates(
      [{ path: "a.appa" }, { path: "new.appa" }],
      runs,
    );
    expect(states.get("a.appa")).toMatchObject({
      status: "failed",
      runAt: runs[1].createdAt,
    });
    expect(states.get("new.appa")).toEqual({
      status: "not_run",
      runAt: null,
      runLabel: null,
      error: null,
    });
  });

  test("names the run that recorded the result and keeps a refused policy's reasons", () => {
    const states = validationFileStates(
      [{ path: "a.appa" }, { path: "b.appa" }],
      [
        run("2", [["a.appa", "h-a", "passed"]], { partial: true }),
        run("1", [["b.appa", "h-b", "cannot_run"]], {
          valid: false,
          errors: ["unknown battery slack"],
        }),
      ],
    );
    expect(states.get("a.appa")).toMatchObject({
      status: "passed",
      runLabel: "Single file run",
    });
    expect(states.get("b.appa")).toMatchObject({
      status: "cannot_run",
      runLabel: "Manual run",
      error: "unknown battery slack",
    });
  });
});

describe("validationSuiteSummary", () => {
  const files = [{ path: "a.appa" }, { path: "b.appa" }, { path: "c.appa" }];

  test("adds a newer single-file result to the last run of all files", () => {
    const summary = validationSuiteSummary(files, [
      run("2", [["a.appa", "h-a", "passed"]], { partial: true }),
      run("1", [
        ["a.appa", "h-a", "failed"],
        ["b.appa", "h-b", "failed"],
        ["c.appa", "h-c", "passed"],
      ]),
    ]);
    expect(summary).toMatchObject({
      status: "failed",
      passed: 2,
      total: 3,
      notRun: 0,
      runAt: "2026-10-02T00:00:00.000Z",
    });
    expect(summary && validationSummaryText(summary)).toBe("2 of 3 passed");
  });

  test("counts files without a result as not run", () => {
    const summary = validationSuiteSummary(files, [
      run("1", [["a.appa", "h-a", "passed"]]),
    ]);
    expect(summary).toMatchObject({ status: "not_run", passed: 1, notRun: 2 });
    expect(summary && validationSummaryText(summary)).toBe(
      "1 of 1 passed · 2 not run",
    );
  });

  test("a newer run that failed before replaying any file wins", () => {
    const summary = validationSuiteSummary(files, [
      run("2", [], { executionError: "GitHub denied access" }),
      run("1", [["a.appa", "h-a", "passed"]]),
    ]);
    expect(summary).toMatchObject({
      status: "cannot_run",
      error: "GitHub denied access",
    });
    expect(summary && validationSummaryText(summary)).toBe("Cannot run");
  });

  test("no result for any current file means no summary", () => {
    expect(
      validationSuiteSummary(files, [run("1", [["gone.appa", "h", "passed"]])]),
    ).toBeNull();
    expect(validationSuiteSummary(files, [])).toBeNull();
  });
});

describe("validationName", () => {
  test.each([
    [
      "# HR records can't be posted publicly\nmcp/x/y {}\n",
      "HR records can't be posted publicly",
    ],
    ["\n  #   Leading space trimmed  \nexpect deny\n", "Leading space trimmed"],
    ["mcp/x/y {}\n# later comment\n", "case.appa"],
    ["", "case.appa"],
  ])("%j → %s", (content, expected) => {
    expect(validationName({ path: "traces/case.appa", content })).toBe(
      expected,
    );
  });
});
