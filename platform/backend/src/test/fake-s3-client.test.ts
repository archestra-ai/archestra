import {
  DeleteObjectCommand,
  GetObjectCommand,
  type GetObjectCommandOutput,
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { describe, expect, test } from "vitest";
import { FakeS3Client } from "./fake-s3-client";

const B = "bucket";

describe("FakeS3Client", () => {
  test("put then get round-trips bytes", async () => {
    const s3 = new FakeS3Client();
    await s3.send(
      new PutObjectCommand({
        Bucket: B,
        Key: "a/x.txt",
        Body: Buffer.from("hi"),
      }),
    );
    const res = (await s3.send(
      new GetObjectCommand({ Bucket: B, Key: "a/x.txt" }),
    )) as GetObjectCommandOutput;
    const bytes = await res.Body?.transformToByteArray();
    expect(Buffer.from(bytes ?? []).toString()).toBe("hi");
  });

  test("conditional put on an existing key throws 412 PreconditionFailed", async () => {
    const s3 = new FakeS3Client();
    await s3.send(
      new PutObjectCommand({
        Bucket: B,
        Key: "a/x.txt",
        Body: Buffer.from("v1"),
      }),
    );
    await expect(
      s3.send(
        new PutObjectCommand({
          Bucket: B,
          Key: "a/x.txt",
          Body: Buffer.from("v2"),
          IfNoneMatch: "*",
        }),
      ),
    ).rejects.toMatchObject({
      name: "PreconditionFailed",
      $metadata: { httpStatusCode: 412 },
    });
  });

  test("get of a missing key throws NoSuchKey 404", async () => {
    const s3 = new FakeS3Client();
    await expect(
      s3.send(new GetObjectCommand({ Bucket: B, Key: "a/missing" })),
    ).rejects.toMatchObject({
      name: "NoSuchKey",
      $metadata: { httpStatusCode: 404 },
    });
  });

  test("delete is idempotent", async () => {
    const s3 = new FakeS3Client();
    await expect(
      s3.send(new DeleteObjectCommand({ Bucket: B, Key: "a/missing" })),
    ).resolves.toBeDefined();
  });

  test("list with delimiter splits direct children from nested prefixes", async () => {
    const s3 = new FakeS3Client();
    s3.putRaw("a/top.txt", "1");
    s3.putRaw("a/sub/deep.txt", "2");
    const res = (await s3.send(
      new ListObjectsV2Command({ Bucket: B, Prefix: "a/", Delimiter: "/" }),
    )) as ListObjectsV2CommandOutput;
    expect((res.Contents ?? []).map((c) => c.Key)).toEqual(["a/top.txt"]);
    expect((res.CommonPrefixes ?? []).map((p) => p.Prefix)).toEqual(["a/sub/"]);
  });

  test("list paginates Contents via the continuation token", async () => {
    const s3 = new FakeS3Client(2); // page size 2
    s3.putRaw("a/1.txt", "x");
    s3.putRaw("a/2.txt", "x");
    s3.putRaw("a/3.txt", "x");
    const p1 = (await s3.send(
      new ListObjectsV2Command({ Bucket: B, Prefix: "a/", Delimiter: "/" }),
    )) as ListObjectsV2CommandOutput;
    expect(p1.Contents?.length).toBe(2);
    expect(p1.IsTruncated).toBe(true);
    const p2 = (await s3.send(
      new ListObjectsV2Command({
        Bucket: B,
        Prefix: "a/",
        Delimiter: "/",
        ContinuationToken: p1.NextContinuationToken,
      }),
    )) as ListObjectsV2CommandOutput;
    expect(p2.Contents?.length).toBe(1);
    expect(p2.IsTruncated).toBe(false);
  });
});
