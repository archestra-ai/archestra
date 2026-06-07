import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { SkillSandboxFile } from "@/types";
import { FilesystemSandboxFileStorage } from "./file-storage-filesystem";

const SANDBOX_ID = "11111111-2222-3333-4444-555555555555";
const FILE_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("FilesystemSandboxFileStorage", () => {
  let root: string;
  let storage: FilesystemSandboxFileStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sandbox-fs-"));
    storage = new FilesystemSandboxFileStorage(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function fileRow(objectKey: string): SkillSandboxFile {
    return {
      storageProvider: "filesystem",
      objectKey,
      data: null,
    } as SkillSandboxFile;
  }

  test("put writes an artifact under <sandboxId>/artifacts and returns the key", async () => {
    const stored = await storage.put({
      sandboxId: SANDBOX_ID,
      fileId: FILE_ID,
      kind: "artifact",
      filename: "report.pdf",
      data: Buffer.from("pdf-bytes"),
    });
    expect(stored).toEqual({
      provider: "filesystem",
      objectKey: `${SANDBOX_ID}/artifacts/report.pdf`,
      dbData: null,
    });
    const onDisk = await readFile(join(root, stored.objectKey ?? ""));
    expect(onDisk.toString()).toBe("pdf-bytes");
  });

  test("put writes uploads under <sandboxId>/uploads", async () => {
    const stored = await storage.put({
      sandboxId: SANDBOX_ID,
      fileId: FILE_ID,
      kind: "upload",
      filename: "data.csv",
      data: Buffer.from("a,b"),
    });
    expect(stored.objectKey).toBe(`${SANDBOX_ID}/uploads/data.csv`);
  });

  test("put suffixes on filename collision instead of overwriting", async () => {
    const first = await storage.put({
      sandboxId: SANDBOX_ID,
      fileId: FILE_ID,
      kind: "artifact",
      filename: "out.txt",
      data: Buffer.from("first"),
    });
    const second = await storage.put({
      sandboxId: SANDBOX_ID,
      fileId: "ffffffff-0000-1111-2222-333333333333",
      kind: "artifact",
      filename: "out.txt",
      data: Buffer.from("second"),
    });
    expect(second.objectKey).toBe(`${SANDBOX_ID}/artifacts/out-ffffffff.txt`);
    // both files exist with their own content
    expect((await readFile(join(root, first.objectKey ?? ""))).toString()).toBe(
      "first",
    );
    expect(
      (await readFile(join(root, second.objectKey ?? ""))).toString(),
    ).toBe("second");
  });

  test("put leaves no temp files behind", async () => {
    await storage.put({
      sandboxId: SANDBOX_ID,
      fileId: FILE_ID,
      kind: "artifact",
      filename: "out.txt",
      data: Buffer.from("x"),
    });
    const files = await readdir(join(root, SANDBOX_ID, "artifacts"));
    expect(files).toEqual(["out.txt"]);
  });

  test("get reads bytes back via the object key", async () => {
    const stored = await storage.put({
      sandboxId: SANDBOX_ID,
      fileId: FILE_ID,
      kind: "upload",
      filename: "in.bin",
      data: Buffer.from([1, 2, 3]),
    });
    const bytes = await storage.get(fileRow(stored.objectKey ?? ""));
    expect([...bytes]).toEqual([1, 2, 3]);
  });

  test("get throws a clear error when the backing file is missing", async () => {
    await expect(
      storage.get(fileRow(`${SANDBOX_ID}/artifacts/gone.txt`)),
    ).rejects.toThrow(/gone\.txt/);
  });

  test("get throws when the row has no object key", async () => {
    await expect(
      storage.get({
        storageProvider: "filesystem",
        objectKey: null,
      } as SkillSandboxFile),
    ).rejects.toThrow(/object key/);
  });

  test("delete removes the file and tolerates a missing one", async () => {
    const stored = await storage.put({
      sandboxId: SANDBOX_ID,
      fileId: FILE_ID,
      kind: "artifact",
      filename: "tmp.txt",
      data: Buffer.from("x"),
    });
    await storage.delete(stored.objectKey ?? "");
    await expect(
      storage.delete(stored.objectKey ?? ""),
    ).resolves.toBeUndefined();
    const files = await readdir(join(root, SANDBOX_ID, "artifacts"));
    expect(files).toEqual([]);
  });
});
