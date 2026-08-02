import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import config from "@/config";
import { describe, expect, test } from "@/test";
import {
  deleteRowsBytesBestEffort,
  FilesystemObjectStore,
} from "./file-storage";
import type { OwnerScope } from "./object-store";

// Separate from file-storage.test.ts: asserting on logger calls requires the
// module mock, which would move that whole (mock-free, fast-project) file
// into the isolated vitest project.
vi.mock("@/logging");

import logger from "@/logging";

const scope: OwnerScope = {
  kind: "user",
  userId: "u1",
  label: "user@example.com",
  conversationId: null,
};

describe("deleteRowsBytesBestEffort", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "fos-purge-"));
    config.fileStorage.filesystemRoot = root;
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test("a failing delete is logged and does not block the rest of the batch", async () => {
    const store = new FilesystemObjectStore(() => root);
    const { key } = await store.write({
      scope,
      name: "healthy.txt",
      data: Buffer.from("x"),
    });

    await expect(
      deleteRowsBytesBestEffort([
        // escapes the root → UnsafePathError from the store
        { storageProvider: "filesystem", objectKey: "../escape.txt" },
        { storageProvider: "filesystem", objectKey: key },
      ]),
    ).resolves.toBeUndefined();

    // the healthy sibling was still deleted
    await expect(
      fs.access(path.join(root, "user@example.com", "healthy.txt")),
    ).rejects.toThrow();

    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "filesystem",
        objectKey: "../escape.txt",
      }),
      expect.stringContaining("failed to delete object bytes"),
    );
  });

  test("drains a batch larger than one concurrency chunk, logging every failure", async () => {
    const store = new FilesystemObjectStore(() => root);
    const rows: { storageProvider: string; objectKey: string | null }[] = [];
    for (let i = 0; i < 20; i++) {
      const { key } = await store.write({
        scope,
        name: `f-${i}.txt`,
        data: Buffer.from("x"),
      });
      rows.push({ storageProvider: "filesystem", objectKey: key });
    }
    rows.splice(3, 0, {
      storageProvider: "filesystem",
      objectKey: "../bad-a.txt",
    });
    rows.push({ storageProvider: "filesystem", objectKey: "../bad-b.txt" });

    await deleteRowsBytesBestEffort(rows);

    // every object was removed — the store drops the emptied owner folder
    await expect(
      fs.access(path.join(root, "user@example.com")),
    ).rejects.toThrow();
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(2);
  });

  test("logs nothing when every delete succeeds", async () => {
    const store = new FilesystemObjectStore(() => root);
    const { key } = await store.write({
      scope,
      name: "a.txt",
      data: Buffer.from("x"),
    });

    await deleteRowsBytesBestEffort([
      { storageProvider: "filesystem", objectKey: key },
      // inline db bytes: no external object, a no-op
      { storageProvider: "db", objectKey: null },
    ]);

    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
  });
});
