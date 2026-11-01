import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { pruneSnapshotCache } from "./pglite-snapshot";

describe("pruneSnapshotCache", () => {
  let directory: string | undefined;
  afterEach(() => {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  test("keeps the newest snapshots and leaves a build in progress alone", () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "pglite-snapshot-"));
    const now = Date.now() / 1000;
    for (const [index, name] of ["a", "b", "c", "d", "e"].entries()) {
      const file = path.join(directory, `${name}.tar.gz`);
      fs.writeFileSync(file, name);
      // a is the oldest, e the newest.
      fs.utimesSync(file, now - 100 + index, now - 100 + index);
    }
    fs.writeFileSync(path.join(directory, "f.tar.gz.123.partial"), "f");

    pruneSnapshotCache(3, directory);

    expect(fs.readdirSync(directory).sort()).toEqual([
      "c.tar.gz",
      "d.tar.gz",
      "e.tar.gz",
      "f.tar.gz.123.partial",
    ]);
  });

  test("does nothing when the cache directory does not exist yet", () => {
    expect(() =>
      pruneSnapshotCache(3, path.join(os.tmpdir(), "no-such-snapshot-cache")),
    ).not.toThrow();
  });
});
