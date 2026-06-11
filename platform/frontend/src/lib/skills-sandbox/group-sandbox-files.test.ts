import { describe, expect, test } from "vitest";
import { groupSandboxFiles } from "./group-sandbox-files";

function file(over: { filename: string; folder?: string | null }) {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    filename: over.filename,
    mimeType: "text/plain",
    sizeBytes: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    downloadable: true,
    folder: over.folder ?? null,
  };
}

describe("groupSandboxFiles", () => {
  test("returns [] for missing data", () => {
    expect(groupSandboxFiles(null)).toEqual([]);
    expect(groupSandboxFiles(undefined)).toEqual([]);
  });

  test("root files first, then folders sorted by name", () => {
    const groups = groupSandboxFiles({
      folders: [
        { id: "f2", name: "zeta", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "f1", name: "alpha", createdAt: "2026-01-01T00:00:00.000Z" },
      ],
      files: [
        file({ filename: "root.txt" }),
        file({ filename: "z1.txt", folder: "zeta" }),
        file({ filename: "a1.txt", folder: "alpha" }),
      ],
    });

    expect(
      groups.map((g) => [g.folder, g.files.map((f) => f.filename)]),
    ).toEqual([
      [null, ["root.txt"]],
      ["alpha", ["a1.txt"]],
      ["zeta", ["z1.txt"]],
    ]);
    expect(groups[1].folderId).toBe("f1");
  });

  test("empty folders keep a group; orphan-dir files create one", () => {
    const groups = groupSandboxFiles({
      folders: [
        { id: "f1", name: "empty", createdAt: "2026-01-01T00:00:00.000Z" },
      ],
      files: [file({ filename: "stray.txt", folder: "hand-made" })],
    });

    expect(groups.map((g) => [g.folder, g.files.length])).toEqual([
      ["empty", 0],
      ["hand-made", 1],
    ]);
    expect(groups[1].folderId).toBeNull();
  });

  test("no root group when every file sits in a folder", () => {
    const groups = groupSandboxFiles({
      folders: [],
      files: [file({ filename: "a.txt", folder: "only" })],
    });
    expect(groups.map((g) => g.folder)).toEqual(["only"]);
  });
});
