import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import { CHATOPS_ATTACHMENT_LIMITS } from "./constants";
import { type ThreadFileScope, threadFileStore } from "./thread-file-store";

const executions: string[] = [];
function scope(): ThreadFileScope {
  const isolationKey = randomUUID();
  executions.push(isolationKey);
  return {
    organizationId: "org",
    userId: "user",
    isolationKey,
    chatOpsBindingId: "binding",
    chatOpsThreadId: "thread",
  };
}
afterEach(() => {
  for (const key of executions.splice(0)) threadFileStore.release(key);
  vi.restoreAllMocks();
});

describe("private thread file originals", () => {
  test("returns metadata and preserves immutable bytes across retain and resolve", () => {
    const context = scope();
    const original = Buffer.from([0, 255, 12, 3]);
    const expected = Buffer.from(original);
    const metadata = threadFileStore.retain({
      scope: context,
      data: original,
      filename: "photo.png",
    });
    expect(metadata).toEqual({
      fileId: expect.stringMatching(/^chatops_file_/),
      filename: "photo.png",
      mimeType: "application/octet-stream",
      sizeBytes: expected.length,
      sha256: createHash("sha256").update(expected).digest("hex"),
    });
    original.fill(4);
    const first = threadFileStore.resolve({
      scope: context,
      fileId: metadata.fileId,
    });
    expect(first?.data).toEqual(expected);
    first?.data.fill(8);
    expect(
      threadFileStore.resolve({ scope: context, fileId: metadata.fileId })
        ?.data,
    ).toEqual(expected);
  });

  test.each([
    { data: Buffer.from("%PDF-1.7\n"), mimeType: "application/pdf" },
    {
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      mimeType: "image/png",
    },
    {
      data: Buffer.from("name,count\nalpha,2\n"),
      mimeType: "application/octet-stream",
    },
  ])("derives $mimeType from the bytes, ignoring the filename", ({
    data,
    mimeType,
  }) => {
    const metadata = threadFileStore.retain({
      scope: scope(),
      data,
      filename: "misleading.jpg",
    });
    expect(metadata.mimeType).toBe(mimeType);
  });

  test.each([
    "organizationId",
    "userId",
    "isolationKey",
    "chatOpsBindingId",
    "chatOpsThreadId",
  ] as const)("rejects a file from another %s", (field) => {
    const context = scope();
    const metadata = threadFileStore.retain({
      scope: context,
      data: Buffer.from("private"),
      filename: "private.png",
    });
    expect(
      threadFileStore.resolve({
        scope: { ...context, [field]: "other" },
        fileId: metadata.fileId,
      }),
    ).toBeNull();
  });

  test("release removes all files for that execution, preserving another execution", () => {
    const a = scope();
    const b = scope();
    const put = (context: ThreadFileScope) =>
      threadFileStore.retain({
        scope: context,
        data: Buffer.from("private"),
        filename: "photo.png",
      });
    const first = put(a);
    const second = put(b);
    threadFileStore.release(a.isolationKey);
    expect(
      threadFileStore.resolve({ scope: a, fileId: first.fileId }),
    ).toBeNull();
    expect(
      threadFileStore
        .resolve({ scope: b, fileId: second.fileId })
        ?.data.toString(),
    ).toBe("private");
  });

  test("bounds the aggregate original bytes within an execution", () => {
    const context = scope();
    threadFileStore.retain({
      scope: context,
      data: Buffer.alloc(
        2 * CHATOPS_ATTACHMENT_LIMITS.MAX_TOTAL_ATTACHMENTS_SIZE,
      ),
      filename: "large.png",
    });
    expect(() =>
      threadFileStore.retain({
        scope: context,
        data: Buffer.from([1]),
        filename: "small.png",
      }),
    ).toThrow("attachment limit");
  });

  test("evicts older files before exceeding the global byte budget", () => {
    const contexts = [scope(), scope(), scope()];
    const files = contexts.map((context) =>
      threadFileStore.retain({
        scope: context,
        data: Buffer.alloc(50 * 1024 * 1024),
        filename: "large.bin",
      }),
    );
    expect(
      threadFileStore.resolve({ scope: contexts[0], fileId: files[0].fileId }),
    ).toBeNull();
    expect(
      threadFileStore.resolve({ scope: contexts[1], fileId: files[1].fileId })
        ?.sizeBytes,
    ).toBe(50 * 1024 * 1024);
    expect(
      threadFileStore.resolve({ scope: contexts[2], fileId: files[2].fileId })
        ?.sizeBytes,
    ).toBe(50 * 1024 * 1024);
  });

  test("expires files after an hour even when execution cleanup is missed", () => {
    const context = scope();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const file = threadFileStore.retain({
      scope: context,
      data: Buffer.from("private"),
      filename: "report.txt",
    });
    vi.spyOn(Date, "now").mockReturnValue(now + 60 * 60 * 1000 + 1);
    expect(
      threadFileStore.resolve({ scope: context, fileId: file.fileId }),
    ).toBeNull();
  });
});
