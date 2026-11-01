import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { pruneSnapshotCache } from "./pglite-snapshot-cache";

describe("pruneSnapshotCache", () => {
  let directory: string | undefined;
  afterEach(() => {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  test("keeps the most recently used snapshots and drops builds that died", () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "pglite-snapshot-"));
    const now = Date.now();
    const hoursAgo = (hours: number) => (now - hours * 3600_000) / 1000;
    const write = (name: string, usedHoursAgo: number) => {
      const file = path.join(directory as string, name);
      fs.writeFileSync(file, name);
      fs.utimesSync(file, hoursAgo(usedHoursAgo), hoursAgo(usedHoursAgo));
    };
    // a was used last 5 hours ago, e 1 hour ago.
    write("a.tar.gz", 5);
    write("b.tar.gz", 4);
    write("c.tar.gz", 3);
    write("d.tar.gz", 2);
    write("e.tar.gz", 1.5);
    // A build that died, and one another run is still writing.
    write("f.tar.gz.123.partial", 2);
    write("g.tar.gz.456.partial", 0.1);

    pruneSnapshotCache(3, directory, now);

    expect(fs.readdirSync(directory).sort()).toEqual([
      "c.tar.gz",
      "d.tar.gz",
      "e.tar.gz",
      "g.tar.gz.456.partial",
    ]);
  });

  test("keeps a snapshot another run may still be reading, even beyond the limit", () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "pglite-snapshot-"));
    const now = Date.now();
    for (const [index, name] of ["a", "b"].entries()) {
      const file = path.join(directory, `${name}.tar.gz`);
      fs.writeFileSync(file, name);
      const seconds = (now - (index + 1) * 60_000) / 1000;
      fs.utimesSync(file, seconds, seconds);
    }

    pruneSnapshotCache(1, directory, now);

    expect(fs.readdirSync(directory).sort()).toEqual(["a.tar.gz", "b.tar.gz"]);
  });

  test("does nothing when the cache directory does not exist yet", () => {
    expect(() =>
      pruneSnapshotCache(3, path.join(os.tmpdir(), "no-such-snapshot-cache")),
    ).not.toThrow();
  });
});
