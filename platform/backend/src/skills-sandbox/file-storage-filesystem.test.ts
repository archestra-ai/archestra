import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { SkillSandboxFile } from "@/types";
import { FilesystemSandboxFileStorage } from "./file-storage-filesystem";

const USER_ID = "11111111-2222-3333-4444-555555555555";
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

  function putParams(params: {
    filename: string;
    data: Buffer;
    fileId?: string;
  }) {
    return {
      userId: USER_ID,
      fileId: params.fileId ?? FILE_ID,
      kind: "artifact" as const,
      filename: params.filename,
      data: params.data,
    };
  }

  test("put writes flat under <userId>/ and returns the key", async () => {
    const stored = await storage.put(
      putParams({ filename: "report.pdf", data: Buffer.from("pdf-bytes") }),
    );
    expect(stored).toEqual({
      provider: "filesystem",
      objectKey: `${USER_ID}/report.pdf`,
      dbData: null,
    });
    const onDisk = await readFile(join(root, stored.objectKey ?? ""));
    expect(onDisk.toString()).toBe("pdf-bytes");
  });

  test("collisions count up Downloads-style", async () => {
    const first = await storage.put(
      putParams({ filename: "out.txt", data: Buffer.from("v1") }),
    );
    const second = await storage.put(
      putParams({
        filename: "out.txt",
        data: Buffer.from("v2"),
        fileId: "ffffffff-0000-1111-2222-333333333333",
      }),
    );
    const third = await storage.put(
      putParams({
        filename: "out.txt",
        data: Buffer.from("v3"),
        fileId: "eeeeeeee-0000-1111-2222-333333333333",
      }),
    );
    expect(first.objectKey).toBe(`${USER_ID}/out.txt`);
    expect(second.objectKey).toBe(`${USER_ID}/out (1).txt`);
    expect(third.objectKey).toBe(`${USER_ID}/out (2).txt`);
    // every version keeps its own content
    expect((await readFile(join(root, first.objectKey ?? ""))).toString()).toBe(
      "v1",
    );
    expect(
      (await readFile(join(root, second.objectKey ?? ""))).toString(),
    ).toBe("v2");
    expect((await readFile(join(root, third.objectKey ?? ""))).toString()).toBe(
      "v3",
    );
  });

  test("counter handles extension-less names", async () => {
    await storage.put(putParams({ filename: "notes", data: Buffer.from("a") }));
    const second = await storage.put(
      putParams({
        filename: "notes",
        data: Buffer.from("b"),
        fileId: "ffffffff-0000-1111-2222-333333333333",
      }),
    );
    expect(second.objectKey).toBe(`${USER_ID}/notes (1)`);
  });

  test("put leaves no temp files behind", async () => {
    await storage.put(
      putParams({ filename: "out.txt", data: Buffer.from("x") }),
    );
    const files = await readdir(join(root, USER_ID));
    expect(files).toEqual(["out.txt"]);
  });

  test("get reads bytes back via the object key", async () => {
    const stored = await storage.put(
      putParams({ filename: "in.bin", data: Buffer.from([1, 2, 3]) }),
    );
    const bytes = await storage.get(fileRow(stored.objectKey ?? ""));
    expect([...bytes]).toEqual([1, 2, 3]);
  });

  test("get throws a clear error when the backing file is missing", async () => {
    await expect(storage.get(fileRow(`${USER_ID}/gone.txt`))).rejects.toThrow(
      /gone\.txt/,
    );
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
    const stored = await storage.put(
      putParams({ filename: "tmp.txt", data: Buffer.from("x") }),
    );
    await storage.delete(stored.objectKey ?? "");
    await expect(
      storage.delete(stored.objectKey ?? ""),
    ).resolves.toBeUndefined();
    const files = await readdir(join(root, USER_ID));
    expect(files).toEqual([]);
  });
});
