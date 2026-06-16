import { describe, expect, test } from "@/test";
import type { StoredBlobRow } from "@/types";
import {
  FileBytesMissingError,
  getFileBytesStorage,
  storageFilename,
} from "./file-storage";

describe("getFileBytesStorage (db provider)", () => {
  const storage = getFileBytesStorage();

  test("put echoes bytes back as dbData with no objectKey", async () => {
    const data = Buffer.from("hello sandbox");
    const stored = await storage.put({
      fileId: "00000000-0000-0000-0000-000000000002",
      filename: "out.txt",
      data,
    });
    expect(stored.objectKey).toBeNull();
    expect(stored.dbData).toBe(data);
    expect(stored.provider).toBe("db");
  });

  test("get returns row bytes as a Buffer when pg returns Buffer", async () => {
    const bytes = await storage.get({
      data: Buffer.from("abc"),
    } as StoredBlobRow);
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(bytes.toString()).toBe("abc");
  });

  test("get normalizes Uint8Array rows (PGlite) to Buffer", async () => {
    const bytes = await storage.get({
      data: new Uint8Array([0x61, 0x62, 0x63]),
    } as unknown as StoredBlobRow);
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(bytes.toString()).toBe("abc");
  });

  test("get throws FileBytesMissingError when the row has no bytes", async () => {
    await expect(
      storage.get({ id: "x", data: null } as StoredBlobRow),
    ).rejects.toBeInstanceOf(FileBytesMissingError);
  });

  test("delete is a no-op for db blobs", async () => {
    await expect(
      storage.delete({ provider: "db", objectKey: null }),
    ).resolves.toBeUndefined();
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
