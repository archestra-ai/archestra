import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach } from "vitest";
import config from "@/config";
import { describe, expect, test } from "@/test";
import type { StoredBlobRow } from "@/types";
import { UnsafePathError } from "./file-path";
import {
  deleteRowBytes,
  FileBytesMissingError,
  FilePathConflictError,
  FilesystemObjectStore,
  getObjectStore,
  type OwnerScope,
  readRowBytes,
  storageFilename,
} from "./file-storage";

function userScope(
  label: string,
  conversationId: string | null = null,
): OwnerScope {
  return { kind: "user", userId: "u1", label, conversationId };
}

describe("readRowBytes / getObjectStore (inline db provider)", () => {
  test("getObjectStore is null under the db provider", () => {
    expect(config.fileStorage.provider).toBe("db");
    expect(getObjectStore()).toBeNull();
  });

  test("reads inline bytes (pg Buffer)", async () => {
    const bytes = await readRowBytes({
      data: Buffer.from("abc"),
    } as StoredBlobRow);
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(bytes.toString()).toBe("abc");
  });

  test("normalizes Uint8Array rows (PGlite) to Buffer", async () => {
    const bytes = await readRowBytes({
      data: new Uint8Array([0x61, 0x62, 0x63]),
    } as unknown as StoredBlobRow);
    expect(bytes.toString()).toBe("abc");
  });

  test("throws FileBytesMissingError when the inline row has no bytes", async () => {
    await expect(
      readRowBytes({ id: "x", data: null } as StoredBlobRow),
    ).rejects.toBeInstanceOf(FileBytesMissingError);
  });

  test("deleteRowBytes is a no-op for inline db blobs", async () => {
    await expect(
      deleteRowBytes({ provider: "db", objectKey: null }),
    ).resolves.toBeUndefined();
  });
});

describe("FilesystemObjectStore", () => {
  let root: string;
  let store: FilesystemObjectStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "fos-"));
    store = new FilesystemObjectStore(() => root);
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test("write lays bytes under <root>/<label>/<name> and round-trips by key", async () => {
    const { key } = await store.write({
      scope: userScope("user@example.com"),
      name: "report.pdf",
      data: Buffer.from("pdf-bytes"),
    });
    expect(key).toBe("user@example.com/report.pdf");
    const onDisk = await fs.readFile(
      path.join(root, "user@example.com", "report.pdf"),
    );
    expect(onDisk.toString()).toBe("pdf-bytes");
    expect((await store.read(key)).toString()).toBe("pdf-bytes");
    expect(await fs.readdir(path.join(root, "user@example.com"))).toEqual([
      "report.pdf",
    ]);
  });

  test("nests a user's conversation files under <email>/<conversationId>/<name>", async () => {
    const { key } = await store.write({
      scope: userScope("user@example.com", "conv-123"),
      name: "report.pdf",
      data: Buffer.from("pdf-bytes"),
    });
    expect(key).toBe("user@example.com/conv-123/report.pdf");
    expect((await store.read(key)).toString()).toBe("pdf-bytes");
    expect(
      await fs.readdir(path.join(root, "user@example.com", "conv-123")),
    ).toEqual(["report.pdf"]);
  });

  test("two conversations may hold a same-named file at distinct keys", async () => {
    const { key: k1 } = await store.write({
      scope: userScope("u@x.com", "c1"),
      name: "same.txt",
      data: Buffer.from("one"),
    });
    const { key: k2 } = await store.write({
      scope: userScope("u@x.com", "c2"),
      name: "same.txt",
      data: Buffer.from("two"),
    });
    expect(k1).toBe("u@x.com/c1/same.txt");
    expect(k2).toBe("u@x.com/c2/same.txt");
    expect((await store.read(k1)).toString()).toBe("one");
    expect((await store.read(k2)).toString()).toBe("two");
  });

  test("enumerate is scoped to the conversation folder", async () => {
    await store.write({
      scope: userScope("u@x.com", "c1"),
      name: "a.txt",
      data: Buffer.from("a"),
    });
    await store.write({
      scope: userScope("u@x.com", "c2"),
      name: "b.txt",
      data: Buffer.from("b"),
    });
    const c1 = await store.enumerate(userScope("u@x.com", "c1"));
    expect(c1.map((o) => o.name)).toEqual(["a.txt"]);
    expect(c1[0].key).toBe("u@x.com/c1/a.txt");
  });

  test("write refuses to overwrite an existing object (exclusive)", async () => {
    const scope = userScope("proj");
    await store.write({ scope, name: "a.txt", data: Buffer.from("first") });
    await expect(
      store.write({ scope, name: "a.txt", data: Buffer.from("second") }),
    ).rejects.toBeInstanceOf(FilePathConflictError);
    expect((await store.read("proj/a.txt")).toString()).toBe("first");
  });

  test("write with overwrite replaces an existing object in place (edit)", async () => {
    const scope = userScope("proj");
    const { key } = await store.write({
      scope,
      name: "a.txt",
      data: Buffer.from("first"),
    });
    const { key: key2 } = await store.write({
      scope,
      name: "a.txt",
      data: Buffer.from("second"),
      overwrite: true,
    });
    expect(key2).toBe(key); // same deterministic key, replaced in place
    expect((await store.read(key)).toString()).toBe("second");
  });

  test("write with overwrite creates the object when absent", async () => {
    const { key } = await store.write({
      scope: userScope("proj"),
      name: "new.txt",
      data: Buffer.from("hi"),
      overwrite: true,
    });
    expect((await store.read(key)).toString()).toBe("hi");
  });

  test("read throws FileBytesMissingError for a missing object", async () => {
    await expect(store.read("proj/missing.txt")).rejects.toBeInstanceOf(
      FileBytesMissingError,
    );
  });

  test("read refuses to follow a symlink (O_NOFOLLOW)", async () => {
    const secret = path.join(root, "secret.txt");
    await fs.writeFile(secret, "secret");
    await fs.mkdir(path.join(root, "proj"), { recursive: true });
    await fs.symlink(secret, path.join(root, "proj", "link.txt"));
    await expect(store.read("proj/link.txt")).rejects.toBeInstanceOf(
      FileBytesMissingError,
    );
  });

  test("rejects keys that escape the root", async () => {
    await expect(store.read("../escape.txt")).rejects.toThrow(UnsafePathError);
  });

  test("refuses a symlinked owner folder that escapes the root", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "fos-out-"));
    await fs.writeFile(path.join(outside, "f.txt"), "leak");
    await fs.symlink(outside, path.join(root, "evil"));
    try {
      await expect(store.read("evil/f.txt")).rejects.toBeInstanceOf(
        UnsafePathError,
      );
      await expect(
        store.write({
          scope: userScope("evil"),
          name: "x.txt",
          data: Buffer.from("x"),
        }),
      ).rejects.toBeInstanceOf(UnsafePathError);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  test("remove deletes the object and tolerates a missing one", async () => {
    const { key } = await store.write({
      scope: userScope("proj"),
      name: "del.txt",
      data: Buffer.from("x"),
    });
    await store.remove(key);
    await expect(store.read(key)).rejects.toBeInstanceOf(FileBytesMissingError);
    await expect(store.remove(key)).resolves.toBeUndefined();
  });

  test("enumerate lists top-level objects, skipping subdirs and symlinks", async () => {
    const scope = userScope("user@example.com");
    await store.write({ scope, name: "a.txt", data: Buffer.from("a") });
    const dir = path.join(root, "user@example.com");
    await fs.writeFile(path.join(dir, "b.txt"), "bb"); // dropped by hand
    await fs.mkdir(path.join(dir, "sub")); // subdir → skipped
    await fs.symlink(
      path.join(root, "user@example.com", "a.txt"),
      path.join(dir, "ln.txt"),
    ); // symlink → skipped

    const objects = await store.enumerate(scope);
    expect(objects.map((o) => o.name).sort()).toEqual(["a.txt", "b.txt"]);
    const b = objects.find((o) => o.name === "b.txt");
    expect(b?.key).toBe("user@example.com/b.txt");
    expect(b?.size).toBe(2);
  });
});

describe("readRowBytes per-row dispatch", () => {
  let root: string;
  let savedRoot: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "fos-router-"));
    savedRoot = config.fileStorage.filesystemRoot;
    // point the filesystem store at the temp root; provider stays "db" so this
    // proves readRowBytes dispatches per ROW, not by the active provider.
    config.fileStorage.filesystemRoot = root;
  });
  afterEach(async () => {
    config.fileStorage.filesystemRoot = savedRoot;
    await fs.rm(root, { recursive: true, force: true });
  });

  test("a filesystem row reads from the store even while the provider is db", async () => {
    expect(config.fileStorage.provider).toBe("db");
    const { key } = await new FilesystemObjectStore(() => root).write({
      scope: userScope("user@example.com"),
      name: "a.txt",
      data: Buffer.from("from-store"),
    });
    const bytes = await readRowBytes({
      id: "1",
      data: null,
      storageProvider: "filesystem",
      objectKey: key,
    } as StoredBlobRow);
    expect(bytes.toString()).toBe("from-store");
  });

  test("a db row reads inline regardless of the store", async () => {
    const bytes = await readRowBytes({
      id: "2",
      data: Buffer.from("from-bytea"),
      storageProvider: "db",
    } as StoredBlobRow);
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
