import { describe, expect, test } from "vitest";
import {
  currentValidationRun,
  validationContentHash,
  validationFileStates,
  validationName,
  validationRunBars,
  validationRunStatus,
} from "./validation-run-history";

type Status = "passed" | "failed" | "cannot_run";

const run = (
  id: string,
  files: [path: string, hash: string, status: Status][],
  extra: { executionError?: string; valid?: boolean } = {},
) => ({
  id,
  createdAt: `2026-10-0${id}T00:00:00.000Z`,
  executionError: extra.executionError ?? null,
  validation: { valid: extra.valid ?? true },
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
  test("a file takes the newest run of its current content, and is not run otherwise", () => {
    const runs = [
      run("3", [["old.appa", "h-old", "passed"]]),
      run("2", [["a.appa", "h-a-v1", "failed"]]),
      run("1", [["a.appa", "h-a-v2", "passed"]]),
    ];
    const states = validationFileStates(
      [
        { path: "a.appa", contentHash: "h-a-v2" },
        { path: "new.appa", contentHash: "h-new" },
      ],
      runs,
    );
    expect(states.get("a.appa")).toMatchObject({
      status: "passed",
      runAt: runs[2].createdAt,
    });
    expect(states.get("new.appa")).toEqual({
      status: "not_run",
      runAt: null,
      error: null,
    });
  });
});

describe("currentValidationRun", () => {
  const files = [{ path: "a.appa", contentHash: "h-a" }];

  test("the newest run counts only when it replayed exactly the current files", () => {
    const latest = run("2", [["a.appa", "h-a", "passed"]]);
    expect(currentValidationRun(files, [latest])).toBe(latest);
  });

  test.each([
    [
      "a deleted file",
      run("2", [
        ["a.appa", "h-a", "passed"],
        ["gone.appa", "h", "passed"],
      ]),
    ],
    ["an edited file", run("2", [["a.appa", "h-old", "passed"]])],
  ])("a run that also covers %s is not current", (_, latest) => {
    expect(currentValidationRun(files, [latest])).toBeNull();
  });

  test("a run that failed before replaying any file stays current", () => {
    const failed = run("2", [], { executionError: "GitHub denied access" });
    expect(currentValidationRun(files, [failed])).toBe(failed);
  });

  test("no files or no runs means no current run", () => {
    expect(currentValidationRun([], [run("1", [])])).toBeNull();
    expect(currentValidationRun(files, [])).toBeNull();
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

test("content hashes match the backend's SHA-256 hex of the UTF-8 text", async () => {
  expect(await validationContentHash("abc")).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
