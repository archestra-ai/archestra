import { describe, expect, test } from "@/test";
import type { SkillSandboxFile } from "@/types";
import { getSandboxFileStorage, storageFilename } from "./file-storage";

describe("getSandboxFileStorage (db provider)", () => {
  const storage = getSandboxFileStorage();

  test("is the db provider", () => {
    expect(storage.name).toBe("db");
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

  test("delete is a no-op", async () => {
    await expect(storage.delete("anything")).resolves.toBeUndefined();
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
