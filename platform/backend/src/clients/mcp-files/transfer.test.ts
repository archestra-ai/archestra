import { createHash } from "node:crypto";
import { describe, expect, test } from "@/test";
import { checkedBytes, FileTransferError, multipartFilename } from "./transfer";

async function* chunks(...parts: string[]) {
  for (const part of parts) yield Buffer.from(part);
}

async function drain(source: AsyncIterable<Uint8Array>) {
  const seen: string[] = [];
  try {
    for await (const chunk of source) seen.push(Buffer.from(chunk).toString());
    return { seen };
  } catch (error) {
    return { seen, error };
  }
}

describe("checkedBytes", () => {
  test("passes the bytes through when they match", async () => {
    const digest = {
      algorithm: "sha-256" as const,
      value: createHash("sha256").update("hello").digest("base64url"),
    };
    expect(
      await drain(checkedBytes(chunks("he", "llo"), { size: 5, digest })),
    ).toEqual({ seen: ["he", "llo"] });
  });

  test("never releases the last chunk of bytes that fail a check", async () => {
    const wrongDigest = await drain(
      checkedBytes(chunks("he", "llo"), {
        size: 5,
        digest: { algorithm: "sha-256", value: "A".repeat(43) },
      }),
    );
    expect(wrongDigest.seen).toEqual(["he"]);
    expect(wrongDigest.error).toBeInstanceOf(FileTransferError);

    const short = await drain(checkedBytes(chunks("he", "ll"), { size: 5 }));
    expect(short.seen).toEqual(["he"]);
    expect(short.error).toBeInstanceOf(FileTransferError);

    const long = await drain(checkedBytes(chunks("he", "llo!"), { size: 5 }));
    expect(long.seen).toEqual([]);
    expect(long.error).toBeInstanceOf(FileTransferError);
  });
});

describe("multipartFilename", () => {
  test.each([
    ["reports/Q3.pdf", "Q3.pdf"],
    ["C:\\tmp\\Q3.pdf", "Q3.pdf"],
    ["..", "file"],
    [".", "file"],
    ["dir/", "file"],
    [undefined, "file"],
  ])("%s -> %s", (name, expected) => {
    expect(multipartFilename(name)).toBe(expected);
  });
});
