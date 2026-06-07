import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { SandboxArtifactRow, SkillSandboxFile } from "@/types";
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

describe("FilesystemSandboxFileStorage.listUserFiles", () => {
  let root: string;
  let storage: FilesystemSandboxFileStorage;
  const userId = "user-xfiles";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "xfiles-list-"));
    storage = new FilesystemSandboxFileStorage(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function row(
    over: Partial<SandboxArtifactRow> & { filename: string },
  ): SandboxArtifactRow {
    return {
      id: "00000000-0000-0000-0000-000000000001",
      mimeType: "text/plain",
      sizeBytes: 0,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      storageProvider: "filesystem",
      objectKey: `${userId}/${over.filename}`,
      ...over,
    };
  }

  test("matched disk files are downloadable with row metadata; orphans are not", async () => {
    const stored = await storage.put({
      userId,
      fileId: "00000000-0000-0000-0000-0000000000aa",
      kind: "artifact",
      filename: "made.txt",
      data: Buffer.from("hello"),
    });
    // a hand-dropped file with no row
    await writeFile(join(root, userId, "manual.csv"), "x,y\n1,2\n");

    const items = await storage.listUserFiles({
      userId,
      rows: [
        row({
          filename: "made.txt",
          id: "00000000-0000-0000-0000-0000000000aa",
          mimeType: "text/plain",
          sizeBytes: 5,
          objectKey: stored.objectKey,
        }),
      ],
    });

    const byName = Object.fromEntries(items.map((i) => [i.filename, i]));
    expect(byName["made.txt"]).toMatchObject({
      id: "00000000-0000-0000-0000-0000000000aa",
      downloadable: true,
      mimeType: "text/plain",
    });
    expect(byName["manual.csv"]).toMatchObject({
      id: null,
      downloadable: false,
      mimeType: "text/csv",
    });
  });

  test("a row whose disk file is absent is omitted (directory is the truth)", async () => {
    await mkdir(join(root, userId), { recursive: true });
    const items = await storage.listUserFiles({
      userId,
      rows: [row({ filename: "ghost.txt" })],
    });
    expect(items).toEqual([]);
  });

  test("skips temp/dot files and returns [] for a missing folder", async () => {
    await mkdir(join(root, userId), { recursive: true });
    await writeFile(join(root, userId, ".hidden"), "x");
    await writeFile(join(root, userId, `.${"abc"}.tmp`), "x");
    const present = await storage.listUserFiles({ userId, rows: [] });
    expect(present).toEqual([]);

    const missing = await storage.listUserFiles({ userId: "never", rows: [] });
    expect(missing).toEqual([]);
  });
});
