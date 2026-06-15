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
import type { SandboxArtifactRow, StoredBlobRow } from "@/types";
import {
  FilesystemSandboxFileStorage,
  SandboxFileMissingError,
} from "./file-storage-filesystem";

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

  function fileRow(objectKey: string): StoredBlobRow {
    return {
      storageProvider: "filesystem",
      objectKey,
      data: null,
    } as StoredBlobRow;
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
      } as StoredBlobRow),
    ).rejects.toThrow(/object key/);
  });

  test("a real user's files are namespaced by email, projects lifted to projects/", async ({
    makeUser,
  }) => {
    const user = await makeUser({ email: "fs-owner@test.com" });
    const personal = await storage.put({
      userId: user.id,
      fileId: FILE_ID,
      kind: "artifact",
      filename: "hi.txt",
      data: Buffer.from("hi"),
    });
    expect(personal.objectKey).toBe("fs-owner@test.com/hi.txt");

    const project = await storage.put({
      userId: user.id,
      fileId: "ffffffff-0000-1111-2222-333333333333",
      kind: "artifact",
      filename: "out.txt",
      data: Buffer.from("out"),
      folder: "proj",
    });
    expect(project.objectKey).toBe("projects/fs-owner@test.com/proj/out.txt");
    const onDisk = await readFile(
      join(root, "projects", "fs-owner@test.com", "proj", "out.txt"),
    );
    expect(onDisk.toString()).toBe("out");
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
      folderId: null,
      folderName: null,
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

    const { files } = await storage.listUserFiles({
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
      folderRows: [],
    });

    const byName = Object.fromEntries(files.map((i) => [i.filename, i]));
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
    const listed = await storage.listUserFiles({
      userId,
      rows: [row({ filename: "ghost.txt" })],
      folderRows: [],
    });
    expect(listed.files).toEqual([]);
  });

  test("skips temp/dot files and returns [] for a missing folder", async () => {
    await mkdir(join(root, userId), { recursive: true });
    await writeFile(join(root, userId, ".hidden"), "x");
    await writeFile(join(root, userId, `.${"abc"}.tmp`), "x");
    const present = await storage.listUserFiles({
      userId,
      rows: [],
      folderRows: [],
    });
    expect(present).toEqual({ folders: [], files: [] });

    const missing = await storage.listUserFiles({
      userId: "never",
      rows: [],
      folderRows: [],
    });
    expect(missing).toEqual({ folders: [], files: [] });
  });

  test("returns matched files newest-first by row createdAt", async () => {
    const older = await storage.put({
      userId,
      fileId: "00000000-0000-0000-0000-0000000000b1",
      kind: "artifact",
      filename: "older.txt",
      data: Buffer.from("o"),
    });
    const newer = await storage.put({
      userId,
      fileId: "00000000-0000-0000-0000-0000000000b2",
      kind: "artifact",
      filename: "newer.txt",
      data: Buffer.from("n"),
    });

    const { files } = await storage.listUserFiles({
      userId,
      rows: [
        row({
          filename: "older.txt",
          objectKey: older.objectKey,
          createdAt: new Date("2026-01-01T00:00:00Z"),
        }),
        row({
          filename: "newer.txt",
          objectKey: newer.objectKey,
          createdAt: new Date("2026-02-01T00:00:00Z"),
        }),
      ],
      folderRows: [],
    });

    expect(files.map((i) => i.filename)).toEqual(["newer.txt", "older.txt"]);
  });

  test("subdirectories are PFS folders; their files are listed one level deep", async () => {
    await mkdir(join(root, userId, "nested"), { recursive: true });
    await mkdir(join(root, userId, "nested", "deeper"), { recursive: true });
    await writeFile(join(root, userId, "flat.txt"), "x");
    await writeFile(join(root, userId, "nested", "inner.txt"), "y");
    await writeFile(join(root, userId, "nested", "deeper", "ignored.txt"), "z");

    const { folders, files } = await storage.listUserFiles({
      userId,
      rows: [],
      folderRows: [],
    });

    expect(folders).toEqual([
      { id: null, name: "nested", createdAt: expect.any(Date) },
    ]);
    expect(files.map((i) => [i.filename, i.folder]).sort()).toEqual([
      ["flat.txt", null],
      ["inner.txt", "nested"],
    ]);
  });

  test("folders carry the row id when one exists; rows without dirs still list", async () => {
    await mkdir(join(root, userId, "reports"), { recursive: true });
    const reportsRow = {
      id: "99999999-9999-9999-9999-999999999999",
      name: "reports",
      createdAt: new Date("2026-03-01T00:00:00Z"),
    };
    const ghostRow = {
      id: "88888888-8888-8888-8888-888888888888",
      name: "gone",
      createdAt: new Date("2026-03-02T00:00:00Z"),
    };

    const { folders } = await storage.listUserFiles({
      userId,
      rows: [],
      folderRows: [reportsRow, ghostRow],
    });

    expect(folders).toEqual([
      { id: ghostRow.id, name: "gone", createdAt: ghostRow.createdAt },
      { id: reportsRow.id, name: "reports", createdAt: reportsRow.createdAt },
    ]);
  });

  test("files inside a folder reconcile with rows by folder-scoped object key", async () => {
    const stored = await storage.put({
      userId,
      fileId: "00000000-0000-0000-0000-0000000000cc",
      kind: "artifact",
      filename: "chart.png",
      data: Buffer.from("png"),
      folder: "reports",
    });
    expect(stored.objectKey).toBe(`projects/${userId}/reports/chart.png`);

    const { files } = await storage.listUserFiles({
      userId,
      rows: [
        row({
          filename: "chart.png",
          id: "00000000-0000-0000-0000-0000000000cc",
          mimeType: "image/png",
          objectKey: stored.objectKey,
        }),
      ],
      folderRows: [
        {
          id: "77777777-7777-7777-7777-777777777777",
          name: "reports",
          createdAt: new Date("2026-03-01T00:00:00Z"),
        },
      ],
    });

    expect(files).toEqual([
      expect.objectContaining({
        id: "00000000-0000-0000-0000-0000000000cc",
        filename: "chart.png",
        folder: "reports",
        downloadable: true,
        mimeType: "image/png",
      }),
    ]);
  });
});

describe("FilesystemSandboxFileStorage folders + readUserFile", () => {
  let root: string;
  let storage: FilesystemSandboxFileStorage;
  const userId = "user-pfs";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "xfiles-pfs-"));
    storage = new FilesystemSandboxFileStorage(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("put with folder writes into the folder dir; collisions stay per-folder", async () => {
    const first = await storage.put({
      userId,
      fileId: "00000000-0000-0000-0000-0000000000d1",
      kind: "artifact",
      filename: "a.txt",
      data: Buffer.from("1"),
      folder: "f1",
    });
    const second = await storage.put({
      userId,
      fileId: "00000000-0000-0000-0000-0000000000d2",
      kind: "artifact",
      filename: "a.txt",
      data: Buffer.from("2"),
      folder: "f1",
    });
    const rootCopy = await storage.put({
      userId,
      fileId: "00000000-0000-0000-0000-0000000000d3",
      kind: "artifact",
      filename: "a.txt",
      data: Buffer.from("3"),
    });

    expect(first.objectKey).toBe(`projects/${userId}/f1/a.txt`);
    expect(second.objectKey).toBe(`projects/${userId}/f1/a (1).txt`);
    // the root has its own counter sequence
    expect(rootCopy.objectKey).toBe(`${userId}/a.txt`);
  });

  test("ensureFolderDir creates the dir and adopts an existing one", async () => {
    await storage.ensureFolderDir({ userId, name: "fresh" });
    await storage.ensureFolderDir({ userId, name: "fresh" });
    const entries = await readdir(join(root, "projects", userId));
    expect(entries).toEqual(["fresh"]);
  });

  test("readUserFile reads root and folder files, including orphans", async () => {
    await mkdir(join(root, userId), { recursive: true });
    await mkdir(join(root, "projects", userId, "docs"), { recursive: true });
    await writeFile(join(root, userId, "root.txt"), "root-bytes");
    await writeFile(
      join(root, "projects", userId, "docs", "inner.txt"),
      "inner-bytes",
    );

    expect(
      (
        await storage.readUserFile({
          userId,
          folder: null,
          filename: "root.txt",
        })
      ).toString(),
    ).toBe("root-bytes");
    expect(
      (
        await storage.readUserFile({
          userId,
          folder: "docs",
          filename: "inner.txt",
        })
      ).toString(),
    ).toBe("inner-bytes");
  });

  test("readUserFile throws SandboxFileMissingError for absent files", async () => {
    await expect(
      storage.readUserFile({ userId, folder: null, filename: "nope.txt" }),
    ).rejects.toBeInstanceOf(SandboxFileMissingError);
  });

  test("path escapes are rejected on every byte path", async () => {
    await mkdir(join(root, userId), { recursive: true });
    await expect(
      storage.readUserFile({ userId, folder: null, filename: "../escape.txt" }),
    ).rejects.toThrow(/escapes/);
    await expect(
      storage.readUserFile({ userId, folder: "..", filename: "escape.txt" }),
    ).rejects.toThrow(/escapes/);
    await expect(
      storage.put({
        userId,
        fileId: "00000000-0000-0000-0000-0000000000e1",
        kind: "artifact",
        filename: "..",
        data: Buffer.from("x"),
      }),
    ).rejects.toThrow();
    await expect(
      storage.get(fileEscapeRow("../../etc/passwd")),
    ).rejects.toThrow(/escapes/);
    await expect(storage.delete("..")).rejects.toThrow(/escapes/);
  });
});

describe("FilesystemSandboxFileStorage symlink hardening", () => {
  let root: string;
  let outside: string;
  let storage: FilesystemSandboxFileStorage;
  const userId = "user-links";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "xfiles-links-"));
    outside = await mkdtemp(join(tmpdir(), "xfiles-outside-"));
    storage = new FilesystemSandboxFileStorage(root);
    await mkdir(join(root, userId), { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  test("put refuses to write through a symlinked folder directory", async () => {
    const { symlink } = await import("node:fs/promises");
    await mkdir(join(root, "projects", userId), { recursive: true });
    await symlink(outside, join(root, "projects", userId, "evil"));

    await expect(
      storage.put({
        userId,
        fileId: "00000000-0000-0000-0000-0000000000f1",
        kind: "artifact",
        filename: "x.txt",
        data: Buffer.from("x"),
        folder: "evil",
      }),
    ).rejects.toThrow(/resolves outside/);
    expect(await readdir(outside)).toEqual([]);
  });

  test("ensureFolderDir refuses an existing symlinked directory", async () => {
    const { symlink } = await import("node:fs/promises");
    await mkdir(join(root, "projects", userId), { recursive: true });
    await symlink(outside, join(root, "projects", userId, "evil"));
    await expect(
      storage.ensureFolderDir({ userId, name: "evil" }),
    ).rejects.toThrow(/resolves outside/);
  });

  test("readUserFile and get refuse symlinked files", async () => {
    const { symlink } = await import("node:fs/promises");
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(join(outside, "secret.txt"), join(root, userId, "alias.txt"));

    await expect(
      storage.readUserFile({ userId, folder: null, filename: "alias.txt" }),
    ).rejects.toThrow(/symlink/);
    await expect(
      storage.get(fileEscapeRow(`${userId}/alias.txt`)),
    ).rejects.toThrow(/symlink/);
  });
});

function fileEscapeRow(objectKey: string): StoredBlobRow {
  return {
    storageProvider: "filesystem",
    objectKey,
    data: null,
  } as StoredBlobRow;
}
