import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import config from "@/config";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { SandboxArtifactRow, SkillSandboxFile } from "@/types";
import { getSandboxFileStorage, storageFilename } from "./file-storage";

describe("getSandboxFileStorage (db provider)", () => {
  const original = { ...config.skillsSandbox.fileStorage };

  beforeEach(() => {
    config.skillsSandbox.fileStorage.provider = "db";
    config.skillsSandbox.fileStorage.path = undefined;
  });

  afterEach(() => {
    config.skillsSandbox.fileStorage.provider = original.provider;
    config.skillsSandbox.fileStorage.path = original.path;
  });

  const storage = getSandboxFileStorage();

  test("is the storage router", () => {
    expect(storage.name).toBe("router");
  });

  test("put echoes bytes back as dbData with no objectKey", async () => {
    const data = Buffer.from("hello sandbox");
    const stored = await storage.put({
      userId: "00000000-0000-0000-0000-000000000001",
      fileId: "00000000-0000-0000-0000-000000000002",
      kind: "artifact",
      filename: "out.txt",
      data,
    });
    expect(stored.objectKey).toBeNull();
    expect(stored.dbData).toBe(data);
    expect(stored.provider).toBe("db");
  });

  test("get returns row bytes as a Buffer when pg returns Buffer", async () => {
    const file = { data: Buffer.from("abc") } as SkillSandboxFile;
    const bytes = await storage.get(file);
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(bytes.toString()).toBe("abc");
  });

  test("get normalizes Uint8Array rows (PGlite) to Buffer", async () => {
    const file = {
      data: new Uint8Array([0x61, 0x62, 0x63]),
    } as unknown as SkillSandboxFile;
    const bytes = await storage.get(file);
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(bytes.toString()).toBe("abc");
  });

  test("delete is a no-op for db blobs", async () => {
    await expect(
      storage.delete({ provider: "db", objectKey: null }),
    ).resolves.toBeUndefined();
  });
});

describe("getSandboxFileStorage routing", () => {
  let root: string;
  const original = { ...config.skillsSandbox.fileStorage };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sandbox-router-"));
  });

  afterEach(async () => {
    config.skillsSandbox.fileStorage.provider = original.provider;
    config.skillsSandbox.fileStorage.path = original.path;
    await rm(root, { recursive: true, force: true });
  });

  test("put routes artifacts to the configured provider", async () => {
    config.skillsSandbox.fileStorage.provider = "filesystem";
    config.skillsSandbox.fileStorage.path = root;
    const stored = await getSandboxFileStorage().put({
      userId: "11111111-2222-3333-4444-555555555555",
      fileId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      kind: "artifact",
      filename: "via-router.txt",
      data: Buffer.from("routed"),
    });
    expect(stored.provider).toBe("filesystem");
    expect(stored.dbData).toBeNull();
    expect(stored.objectKey).toBe(
      "11111111-2222-3333-4444-555555555555/via-router.txt",
    );
  });

  test("put routes uploads to db even when filesystem is configured", async () => {
    config.skillsSandbox.fileStorage.provider = "filesystem";
    config.skillsSandbox.fileStorage.path = root;
    const data = Buffer.from("replay input");
    const stored = await getSandboxFileStorage().put({
      userId: "11111111-2222-3333-4444-555555555555",
      fileId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      kind: "upload",
      filename: "in.csv",
      data,
    });
    expect(stored.provider).toBe("db");
    expect(stored.dbData).toBe(data);
    expect(stored.objectKey).toBeNull();
    // and the storage root was never touched
    expect(await readdir(root)).toEqual([]);
  });

  test("get resolves per row, not per config", async () => {
    // config says filesystem, but a db-provider row still reads from bytea
    config.skillsSandbox.fileStorage.provider = "filesystem";
    config.skillsSandbox.fileStorage.path = root;
    const bytes = await getSandboxFileStorage().get({
      storageProvider: "db",
      data: Buffer.from("from-bytea"),
      objectKey: null,
    } as SkillSandboxFile);
    expect(bytes.toString()).toBe("from-bytea");
  });
});

describe("storageFilename", () => {
  test("prefers originalName when present", () => {
    expect(
      storageFilename({ originalName: "report.csv", path: "/home/sandbox/x" }),
    ).toBe("report.csv");
  });

  test("falls back to the basename of the container path", () => {
    expect(
      storageFilename({
        originalName: null,
        path: "/home/sandbox/out/plot.png",
      }),
    ).toBe("plot.png");
  });

  test("falls back to 'file' when the path has no basename", () => {
    expect(storageFilename({ originalName: null, path: "/" })).toBe("file");
  });
});

describe("SandboxFileStorageRouter.listUserFiles (db provider)", () => {
  const original = { ...config.skillsSandbox.fileStorage };
  beforeEach(() => {
    config.skillsSandbox.fileStorage.provider = "db";
    config.skillsSandbox.fileStorage.path = undefined;
  });
  afterEach(() => {
    config.skillsSandbox.fileStorage.provider = original.provider;
    config.skillsSandbox.fileStorage.path = original.path;
  });

  test("maps rows to items, all downloadable, in input order", async () => {
    const rows: SandboxArtifactRow[] = [
      {
        id: "11111111-1111-1111-1111-111111111111",
        filename: "a.txt",
        mimeType: "text/plain",
        sizeBytes: 3,
        createdAt: new Date("2026-01-02T00:00:00Z"),
        storageProvider: "db",
        objectKey: null,
      },
      {
        id: "22222222-2222-2222-2222-222222222222",
        filename: "b.png",
        mimeType: "image/png",
        sizeBytes: 9,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        storageProvider: "db",
        objectKey: null,
      },
    ];

    const items = await getSandboxFileStorage().listUserFiles({
      userId: "user-1",
      rows,
    });

    expect(items).toEqual([
      {
        id: rows[0].id,
        filename: "a.txt",
        mimeType: "text/plain",
        sizeBytes: 3,
        createdAt: rows[0].createdAt,
        downloadable: true,
      },
      {
        id: rows[1].id,
        filename: "b.png",
        mimeType: "image/png",
        sizeBytes: 9,
        createdAt: rows[1].createdAt,
        downloadable: true,
      },
    ]);
  });
});
