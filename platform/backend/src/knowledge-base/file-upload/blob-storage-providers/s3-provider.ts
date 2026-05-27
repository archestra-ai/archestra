import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import config from "@/config";
import type { BlobStorageProvider, StoredBlobPointer } from "./types";

class S3BlobStorageProvider implements BlobStorageProvider {
  readonly name = "s3" as const;

  private client: S3Client | null = null;

  async put(params: {
    organizationId: string;
    fileId: string;
    filename: string;
    mimeType: string;
    data: Buffer;
  }): Promise<StoredBlobPointer> {
    const bucket = this.getBucket();
    const key = this.buildKey(params);
    await this.getClient().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: params.data,
        ContentType: params.mimeType || "application/octet-stream",
      }),
    );

    return {
      provider: this.name,
      key,
      dbData: null,
    };
  }

  async get(params: {
    key: string | null;
    dbData: Buffer | null;
  }): Promise<Buffer> {
    if (!params.key) {
      throw new Error("S3 object key is missing");
    }

    const result = await this.getClient().send(
      new GetObjectCommand({
        Bucket: this.getBucket(),
        Key: params.key,
      }),
    );

    if (!result.Body) {
      throw new Error("S3 object body is empty");
    }

    return Buffer.from(await result.Body.transformToByteArray());
  }

  async delete(params: { key: string | null }): Promise<void> {
    if (!params.key) return;

    await this.getClient().send(
      new DeleteObjectCommand({
        Bucket: this.getBucket(),
        Key: params.key,
      }),
    );
  }

  private getClient(): S3Client {
    if (this.client) return this.client;

    const s3Config = config.kb.fileUpload.blobStorage.s3;
    // The SDK credential provider refreshes IRSA credentials for this cached
    // client; runtime env var changes require process restart.
    this.client = new S3Client({
      region: s3Config.region || undefined,
      endpoint: s3Config.endpoint || undefined,
      forcePathStyle: s3Config.forcePathStyle,
      credentials:
        s3Config.authMethod === "static"
          ? {
              accessKeyId: s3Config.accessKeyId,
              secretAccessKey: s3Config.secretAccessKey,
            }
          : fromNodeProviderChain(),
    });
    return this.client;
  }

  private getBucket(): string {
    const bucket = config.kb.fileUpload.blobStorage.s3.bucket;
    if (!bucket) {
      throw new Error(
        "ARCHESTRA_KNOWLEDGE_BASE_FILE_UPLOAD_S3_BUCKET is required when S3 blob storage is enabled",
      );
    }
    return bucket;
  }

  private buildKey(params: {
    organizationId: string;
    fileId: string;
    filename: string;
  }): string {
    const prefix = config.kb.fileUpload.blobStorage.s3.prefix
      .replace(/^\/+|\/+$/g, "")
      .trim();
    const safeFilename =
      params.filename
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .replace(/^\.+/, "")
        .replace(/\.{2,}/g, ".") || "file";
    const key = `${params.organizationId}/${params.fileId}/${safeFilename}`;
    return prefix ? `${prefix}/${key}` : key;
  }
}

export const s3BlobStorageProvider = new S3BlobStorageProvider();
