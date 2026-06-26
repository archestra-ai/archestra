import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { S3Client } from "@aws-sdk/client-s3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { FakeS3Client } from "@/test/fake-s3-client";
import { FilesystemObjectStore } from "./file-storage";
import {
  type EnumerableObjectStore,
  FileBytesMissingError,
  FilePathConflictError,
  type OwnerScope,
} from "./object-store";
import { S3ObjectStore } from "./s3-storage";

// Project scope → folder "acme" on either backend.
const SCOPE: OwnerScope = { kind: "project", projectId: "p1", label: "acme" };

type Harness = {
  store: EnumerableObjectStore;
  dropRaw: (folder: string, name: string, content: string) => Promise<void>;
  cleanup: () => Promise<void>;
};

async function fsHarness(): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "contract-fs-"));
  return {
    store: new FilesystemObjectStore(() => root),
    dropRaw: async (folder, name, content) => {
      const dir = path.join(root, folder);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, name), content);
    },
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

async function s3Harness(): Promise<Harness> {
  const fake = new FakeS3Client();
  return {
    store: new S3ObjectStore({
      getClient: () => fake as unknown as S3Client,
      getBucket: () => "test-bucket",
      getKeyPrefix: () => "",
    }),
    dropRaw: async (folder, name, content) =>
      fake.putRaw(`${folder}/${name}`, content),
    cleanup: async () => {},
  };
}

describe.each([
  ["filesystem", fsHarness],
  ["s3", s3Harness],
])("EnumerableObjectStore contract: %s", (_name, makeHarness) => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  test("write then read round-trips by key", async () => {
    const { key } = await h.store.write({
      scope: SCOPE,
      name: "a.txt",
      data: Buffer.from("hello"),
    });
    expect(key).toBe("acme/a.txt");
    expect((await h.store.read(key)).toString()).toBe("hello");
  });

  test("exclusive create conflicts on an existing name", async () => {
    await h.store.write({
      scope: SCOPE,
      name: "a.txt",
      data: Buffer.from("v1"),
    });
    await expect(
      h.store.write({ scope: SCOPE, name: "a.txt", data: Buffer.from("v2") }),
    ).rejects.toBeInstanceOf(FilePathConflictError);
  });

  test("overwrite replaces bytes without conflict", async () => {
    const { key } = await h.store.write({
      scope: SCOPE,
      name: "a.txt",
      data: Buffer.from("v1"),
    });
    await h.store.write({
      scope: SCOPE,
      name: "a.txt",
      data: Buffer.from("v2"),
      overwrite: true,
    });
    expect((await h.store.read(key)).toString()).toBe("v2");
  });

  test("read of a missing key throws FileBytesMissingError", async () => {
    await expect(h.store.read("acme/missing.txt")).rejects.toBeInstanceOf(
      FileBytesMissingError,
    );
  });

  test("remove deletes the bytes", async () => {
    const { key } = await h.store.write({
      scope: SCOPE,
      name: "a.txt",
      data: Buffer.from("x"),
    });
    await h.store.remove(key);
    await expect(h.store.read(key)).rejects.toBeInstanceOf(
      FileBytesMissingError,
    );
  });

  test("remove of an absent key does not throw", async () => {
    await expect(h.store.remove("acme/missing.txt")).resolves.toBeUndefined();
  });

  test("enumerate surfaces a hand-dropped object with size + modifiedAt", async () => {
    await h.dropRaw("acme", "dropped.csv", "a,b,c");
    const objs = await h.store.enumerate(SCOPE);
    expect(objs.map((o) => o.name)).toEqual(["dropped.csv"]);
    expect(objs[0].key).toBe("acme/dropped.csv");
    expect(objs[0].size).toBe(5);
    expect(objs[0].modifiedAt).toBeInstanceOf(Date);
  });

  test("enumerate skips nested (subfolder) objects", async () => {
    await h.dropRaw("acme", "top.txt", "x");
    await h.dropRaw("acme/sub", "deep.txt", "y");
    expect((await h.store.enumerate(SCOPE)).map((o) => o.name)).toEqual([
      "top.txt",
    ]);
  });

  test("enumerate skips un-addressable names", async () => {
    await h.dropRaw("acme", ".hidden", "x");
    await h.dropRaw("acme", "ok.txt", "y");
    expect((await h.store.enumerate(SCOPE)).map((o) => o.name)).toEqual([
      "ok.txt",
    ]);
  });

  test("enumerate of an empty scope returns []", async () => {
    expect(await h.store.enumerate(SCOPE)).toEqual([]);
  });
});

// keyPrefix is S3-only (no filesystem analogue), so it lives outside the shared
// contract: the prefix is applied to the underlying bucket key but stripped from
// the store-level key/name the caller sees.
describe("S3ObjectStore keyPrefix", () => {
  test("write prefixes the underlying object but returns a prefix-free key", async () => {
    const fake = new FakeS3Client();
    const store = new S3ObjectStore({
      getClient: () => fake as unknown as S3Client,
      getBucket: () => "test-bucket",
      getKeyPrefix: () => "tenant1",
    });

    const { key } = await store.write({
      scope: SCOPE,
      name: "a.txt",
      data: Buffer.from("hello"),
    });
    expect(key).toBe("acme/a.txt"); // keyPrefix-free
    expect((await store.read("acme/a.txt")).toString()).toBe("hello");

    // The bytes really live under the prefixed bucket key: a prefix-free store
    // over the SAME fake cannot reach them (keyPrefix isolation).
    const noPrefix = new S3ObjectStore({
      getClient: () => fake as unknown as S3Client,
      getBucket: () => "test-bucket",
      getKeyPrefix: () => "",
    });
    await expect(noPrefix.read("acme/a.txt")).rejects.toBeInstanceOf(
      FileBytesMissingError,
    );
  });

  test("enumerate strips the keyPrefix from key and name", async () => {
    const fake = new FakeS3Client();
    const store = new S3ObjectStore({
      getClient: () => fake as unknown as S3Client,
      getBucket: () => "test-bucket",
      getKeyPrefix: () => "tenant1",
    });

    fake.putRaw("tenant1/acme/dropped.csv", "a,b,c");
    const objs = await store.enumerate(SCOPE);
    expect(objs.map((o) => o.name)).toEqual(["dropped.csv"]);
    expect(objs[0].key).toBe("acme/dropped.csv"); // keyPrefix-free
    expect(objs[0].size).toBe(5);
  });
});
