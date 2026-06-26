import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";

type Entry = { body: Buffer; lastModified: Date };

/**
 * In-memory S3 double for tests. Network is a true boundary (per CLAUDE.md), so
 * the real `S3Client` is replaced with this `Map`-backed fake implementing just
 * the four commands `S3ObjectStore` uses. `pageSize` forces the continuation loop.
 *
 * @public — test double, consumed only by tests.
 */
export class FakeS3Client {
  private readonly objects = new Map<string, Entry>();

  constructor(private readonly pageSize = 2) {}

  async send(command: unknown): Promise<unknown> {
    if (command instanceof PutObjectCommand) return this.put(command.input);
    if (command instanceof GetObjectCommand) return this.get(command.input);
    if (command instanceof DeleteObjectCommand) return this.del(command.input);
    if (command instanceof ListObjectsV2Command)
      return this.list(command.input);
    throw new Error(
      `FakeS3Client: unsupported command ${(command as object)?.constructor?.name}`,
    );
  }

  /** Place an object directly (a "hand-dropped" file), bypassing exclusive create. */
  putRaw(key: string, body: string | Buffer): void {
    this.objects.set(key, {
      body: Buffer.from(body),
      lastModified: new Date(),
    });
  }

  // === internal ===

  private put(input: { Key?: string; Body?: unknown; IfNoneMatch?: string }) {
    const key = input.Key ?? "";
    if (input.IfNoneMatch === "*" && this.objects.has(key)) {
      throw Object.assign(new Error("precondition failed"), {
        name: "PreconditionFailed",
        $metadata: { httpStatusCode: 412 },
      });
    }
    this.objects.set(key, {
      body: Buffer.from(input.Body as Buffer),
      lastModified: new Date(),
    });
    return {};
  }

  private get(input: { Key?: string }) {
    const entry = this.objects.get(input.Key ?? "");
    if (!entry) {
      throw Object.assign(new Error("not found"), {
        name: "NoSuchKey",
        $metadata: { httpStatusCode: 404 },
      });
    }
    return {
      Body: { transformToByteArray: async () => new Uint8Array(entry.body) },
    };
  }

  private del(input: { Key?: string }) {
    this.objects.delete(input.Key ?? "");
    return {};
  }

  private list(input: {
    Prefix?: string;
    Delimiter?: string;
    ContinuationToken?: string;
  }) {
    const prefix = input.Prefix ?? "";
    const delimiter = input.Delimiter;
    const matching = [...this.objects.keys()]
      .filter((k) => k.startsWith(prefix))
      .sort();
    const contents: string[] = [];
    const commonPrefixes = new Set<string>();
    for (const key of matching) {
      const rest = key.slice(prefix.length);
      if (delimiter && rest.includes(delimiter)) {
        commonPrefixes.add(prefix + rest.slice(0, rest.indexOf(delimiter) + 1));
      } else {
        contents.push(key);
      }
    }
    const start = input.ContinuationToken ? Number(input.ContinuationToken) : 0;
    const page = contents.slice(start, start + this.pageSize);
    const next = start + this.pageSize;
    const truncated = next < contents.length;
    return {
      Contents: page.map((key) => {
        const e = this.objects.get(key) as Entry;
        return {
          Key: key,
          Size: e.body.byteLength,
          LastModified: e.lastModified,
        };
      }),
      CommonPrefixes: [...commonPrefixes].map((Prefix) => ({ Prefix })),
      IsTruncated: truncated,
      NextContinuationToken: truncated ? String(next) : undefined,
    };
  }
}
