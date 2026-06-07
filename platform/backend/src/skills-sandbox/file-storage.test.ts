import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import config from "@/config";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { SkillSandboxFile } from "@/types";
import { getSandboxFileStorage, storageFilename } from "./file-storage";

describe("getSandboxFileStorage (db provider)", () => {
  const storage = getSandboxFileStorage();

  test("is the storage router", () => {
    expect(storage.name).toBe("router");
  });

  test("put echoes bytes back as dbData with no objectKey", async () => {
    const data = Buffer.from("hello sandbox");
    const stored = await storage.put({
      sandboxId: "00000000-0000-0000-0000-000000000001",
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

  test("put follows the configured provider", async () => {
    config.skillsSandbox.fileStorage.provider = "filesystem";
    config.skillsSandbox.fileStorage.path = root;
    const stored = await getSandboxFileStorage().put({
      sandboxId: "11111111-2222-3333-4444-555555555555",
      fileId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      kind: "artifact",
      filename: "via-router.txt",
      data: Buffer.from("routed"),
    });
    expect(stored.provider).toBe("filesystem");
    expect(stored.dbData).toBeNull();
    expect(stored.objectKey).toContain("via-router.txt");
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
