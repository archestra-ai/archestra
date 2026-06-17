import { describe, expect, test } from "vitest";
import { groupSandboxFiles } from "./group-sandbox-files";

function file(over: {
  filename: string;
  projectId?: string | null;
  projectName?: string | null;
}) {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    filename: over.filename,
    mimeType: "text/plain",
    sizeBytes: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    downloadable: true,
    projectId: over.projectId ?? null,
    projectName: over.projectName ?? null,
  };
}

describe("groupSandboxFiles", () => {
  test("returns [] for missing data", () => {
    expect(groupSandboxFiles(null)).toEqual([]);
    expect(groupSandboxFiles(undefined)).toEqual([]);
  });

  test("own files first, then projects sorted by name", () => {
    const groups = groupSandboxFiles({
      files: [
        file({ filename: "mine.txt" }),
        file({ filename: "z1.txt", projectId: "p2", projectName: "zeta" }),
        file({ filename: "a1.txt", projectId: "p1", projectName: "alpha" }),
      ],
    });

    expect(
      groups.map((g) => [g.project, g.files.map((f) => f.filename)]),
    ).toEqual([
      [null, ["mine.txt"]],
      ["alpha", ["a1.txt"]],
      ["zeta", ["z1.txt"]],
    ]);
    expect(groups[1].projectId).toBe("p1");
  });

  test("files sharing a project name group together", () => {
    const groups = groupSandboxFiles({
      files: [
        file({ filename: "a.txt", projectId: "p1", projectName: "alpha" }),
        file({ filename: "b.txt", projectId: "p1", projectName: "alpha" }),
      ],
    });

    expect(
      groups.map((g) => [g.project, g.files.map((f) => f.filename)]),
    ).toEqual([["alpha", ["a.txt", "b.txt"]]]);
    expect(groups[0].projectId).toBe("p1");
  });

  test("no own group when every file belongs to a project", () => {
    const groups = groupSandboxFiles({
      files: [
        file({ filename: "a.txt", projectId: "p1", projectName: "only" }),
      ],
    });
    expect(groups.map((g) => g.project)).toEqual(["only"]);
  });

  test("a file with projectId but no projectName falls into own files", () => {
    const groups = groupSandboxFiles({
      files: [file({ filename: "x.txt", projectId: "p1", projectName: null })],
    });
    expect(groups.map((g) => g.project)).toEqual([null]);
    expect(groups[0].files.map((f) => f.filename)).toEqual(["x.txt"]);
  });

  test("two distinct projects with the same name stay separate groups", () => {
    const groups = groupSandboxFiles({
      files: [
        {
          ...file({
            filename: "a.txt",
            projectId: "p-aaa",
            projectName: "reports",
          }),
          id: "f1",
        },
        {
          ...file({
            filename: "b.txt",
            projectId: "p-bbb",
            projectName: "reports",
          }),
          id: "f2",
        },
      ],
    });
    const reports = groups.filter((g) => g.project === "reports");
    expect(reports).toHaveLength(2);
    expect(new Set(reports.map((g) => g.projectId))).toEqual(
      new Set(["p-aaa", "p-bbb"]),
    );
    expect(reports.flatMap((g) => g.files.map((f) => f.id)).sort()).toEqual([
      "f1",
      "f2",
    ]);
  });
});
