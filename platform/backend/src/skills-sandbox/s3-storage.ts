import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { FileStorageS3Config } from "@/config";
import { safeSegment } from "./file-path";
import {
  type EnumerableObjectStore,
  FileBytesMissingError,
  FilePathConflictError,
  type OwnerScope,
  type StoredObject,
  scopeFolder,
} from "./object-store";

/**
 * Build the real S3 client; undefined credentials → AWS default chain (IAM/IRSA).
 *
 * @public — consumed by the file-storage provider factory.
 */
export function buildS3Client(s3: FileStorageS3Config): S3Client {
  return new S3Client({
    region: s3.region,
    endpoint: s3.endpoint,
    forcePathStyle: s3.forcePathStyle,
    credentials:
      s3.accessKeyId && s3.secretAccessKey
        ? { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey }
        : undefined,
  });
}

/**
 * Bytes in an S3-compatible bucket, laid out `<keyPrefix>/<folder>/<name>` (the
 * folder is the owner's email — optionally `/conversationId` — or project slug,
 * identical to the filesystem layout). Exclusive create is conditional
 * (`IfNoneMatch: "*"` → 412 = conflict); `overwrite` (edit) is a plain put. The
 * client/bucket/prefix are read through thunks so the singleton tracks config and
 * tests inject a fake client.
 *
 * @public — constructed directly in the contract test with an injected client.
 */
export class S3ObjectStore implements EnumerableObjectStore {
  constructor(
    private readonly deps: {
      getClient: () => S3Client;
      getBucket: () => string;
      getKeyPrefix: () => string;
    },
  ) {}

  async write(params: {
    scope: OwnerScope;
    name: string;
    data: Buffer;
    overwrite?: boolean;
  }): Promise<{ key: string }> {
    const key = `${scopeFolder(params.scope)}/${safeSegment(params.name)}`;
    try {
      await this.deps.getClient().send(
        new PutObjectCommand({
          Bucket: this.deps.getBucket(),
          Key: this.prefixed(key),
          Body: params.data,
          ...(params.overwrite ? {} : { IfNoneMatch: "*" }),
        }),
      );
    } catch (error) {
      if (isPreconditionFailed(error)) throw new FilePathConflictError(key);
      throw error;
    }
    return { key };
  }

  async read(key: string): Promise<Buffer> {
    try {
      const res = await this.deps.getClient().send(
        new GetObjectCommand({
          Bucket: this.deps.getBucket(),
          Key: this.prefixed(key),
        }),
      );
      const bytes = await res.Body?.transformToByteArray();
      if (!bytes) throw new FileBytesMissingError(key);
      return Buffer.from(bytes);
    } catch (error) {
      if (error instanceof FileBytesMissingError) throw error;
      if (isNotFound(error)) throw new FileBytesMissingError(key);
      throw error;
    }
  }

  async remove(key: string): Promise<void> {
    await this.deps.getClient().send(
      new DeleteObjectCommand({
        Bucket: this.deps.getBucket(),
        Key: this.prefixed(key),
      }),
    );
  }

  async enumerate(scope: OwnerScope): Promise<StoredObject[]> {
    let folder: string;
    try {
      folder = scopeFolder(scope);
    } catch {
      return [];
    }
    const prefix = this.prefixed(`${folder}/`);
    const out: StoredObject[] = [];
    let token: string | undefined;
    do {
      const res = await this.deps.getClient().send(
        new ListObjectsV2Command({
          Bucket: this.deps.getBucket(),
          Prefix: prefix,
          Delimiter: "/",
          ContinuationToken: token,
        }),
      );
      for (const obj of res.Contents ?? []) {
        if (!obj.Key) continue;
        const name = obj.Key.slice(prefix.length);
        if (!name) continue; // a folder-marker object, not a file
        try {
          if (safeSegment(name) !== name) continue;
        } catch {
          continue; // un-addressable name
        }
        out.push({
          key: `${folder}/${name}`,
          name,
          size: obj.Size ?? 0,
          modifiedAt: obj.LastModified ?? new Date(0),
        });
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  // === internal ===

  private prefixed(key: string): string {
    const prefix = this.deps.getKeyPrefix();
    return prefix ? `${prefix}/${key}` : key;
  }
}

// === internal ===

function isPreconditionFailed(error: unknown): boolean {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e?.name === "PreconditionFailed" || e?.$metadata?.httpStatusCode === 412
  );
}

function isNotFound(error: unknown): boolean {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e?.name === "NoSuchKey" ||
    e?.name === "NotFound" ||
    e?.$metadata?.httpStatusCode === 404
  );
}
