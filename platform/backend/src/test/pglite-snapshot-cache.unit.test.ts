import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  claimSnapshot,
  pruneSnapshotCache,
  publishedSnapshotIsCurrent,
} from "./pglite-snapshot-cache";

afterEach(() => {
  vi.restoreAllMocks();
});

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
    // The names of a run that died before its teardown, and of a live run,
    // with the times they claimed their snapshots.
    write(`h.tar.gz.789-${now - 25 * 3600_000}.inuse`, 25);
    write(`e.tar.gz.790-${now - 1.5 * 3600_000}.inuse`, 1.5);

    pruneSnapshotCache(3, directory, now);

    expect(fs.readdirSync(directory).sort()).toEqual([
      "c.tar.gz",
      "d.tar.gz",
      "e.tar.gz",
      `e.tar.gz.790-${now - 1.5 * 3600_000}.inuse`,
      "g.tar.gz.456.partial",
    ]);
  });

  test("keeps a snapshot another run uses between the listing and the removal", () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "pglite-snapshot-"));
    const now = Date.now();
    const snapshot = path.join(directory, "a.tar.gz");
    fs.writeFileSync(snapshot, "a");
    const daysAgo = (now - 48 * 3600_000) / 1000;
    fs.utimesSync(snapshot, daysAgo, daysAgo);
    // Another run claims the snapshot right after this one listed it: its
    // second look at the file is the check before the removal.
    const statSync = fs.statSync;
    let looks = 0;
    vi.spyOn(fs, "statSync").mockImplementation(((
      file: fs.PathLike,
      options?: fs.StatSyncOptions,
    ) => {
      if (file === snapshot && ++looks === 2) claimSnapshot(snapshot);
      return statSync(file, options);
    }) as typeof fs.statSync);

    pruneSnapshotCache(0, directory, now);

    expect(looks).toBe(2);
    expect(fs.existsSync(snapshot)).toBe(true);
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

  test("removes a dead run's name by its claim time, though later claims of the snapshot refresh its mtime", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "pglite-snapshot-"),
    );
    try {
      const now = Date.now();
      const snapshot = path.join(directory, "a.tar.gz");
      fs.writeFileSync(snapshot, "snapshot");
      // Another process claimed the snapshot two days ago and died: its name is
      // a hard link to the cached file, as claimSnapshot makes it.
      const abandoned = `${snapshot}.${process.pid + 1}-${now - 48 * 3600_000}.inuse`;
      fs.linkSync(snapshot, abandoned);
      // This run's claim refreshes the mtime the two names share.
      const runSnapshot = claimSnapshot(snapshot);

      pruneSnapshotCache(3, directory, now);

      expect(fs.existsSync(abandoned)).toBe(false);
      expect(fs.existsSync(snapshot)).toBe(true);
      expect(fs.existsSync(runSnapshot as string)).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("claimSnapshot", () => {
  let directory: string | undefined;
  afterEach(() => {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  test("gives the run a name for the snapshot that pruning the cache does not remove", () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "pglite-snapshot-"));
    const snapshot = path.join(directory, "a.tar.gz");
    fs.writeFileSync(snapshot, "snapshot");

    const runSnapshot = claimSnapshot(snapshot);
    expect(runSnapshot).not.toBeNull();
    // A pruner that listed the snapshot before this run used it removes it.
    fs.rmSync(snapshot);

    expect(fs.readFileSync(runSnapshot as string, "utf8")).toBe("snapshot");
  });

  test("returns null when the snapshot is not cached", () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "pglite-snapshot-"));

    expect(claimSnapshot(path.join(directory, "a.tar.gz"))).toBeNull();
    expect(fs.readdirSync(directory)).toEqual([]);
  });
});

describe("publishedSnapshotIsCurrent", () => {
  let directory: string | undefined;
  afterEach(() => {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  test("reuses only this run's name for the current snapshot, while it exists", () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "pglite-snapshot-"));
    const current = path.join(directory, "current.tar.gz");
    fs.writeFileSync(current, "snapshot");
    const runSnapshot = claimSnapshot(current) as string;

    expect(publishedSnapshotIsCurrent(runSnapshot, current)).toBe(true);
    // The cached name itself, another snapshot's run name, or none.
    expect(publishedSnapshotIsCurrent(current, current)).toBe(false);
    const old = path.join(directory, "old.tar.gz");
    fs.writeFileSync(old, "snapshot");
    expect(
      publishedSnapshotIsCurrent(claimSnapshot(old) as string, current),
    ).toBe(false);
    expect(publishedSnapshotIsCurrent(undefined, current)).toBe(false);

    // This run's name, but its file was deleted.
    fs.rmSync(runSnapshot);
    expect(publishedSnapshotIsCurrent(runSnapshot, current)).toBe(false);
  });
});
