import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { fromTemporaryCredentials } from "@aws-sdk/credential-providers";
import type {
  S3BlobProviderConfig,
  S3BlobProviderCredentials,
} from "@/types/blob-provider";
import { BlobProvider } from "./blob-provider";

/**
 * An Amazon S3 bucket, or any S3-compatible store (MinIO, Cloudflare R2, Ceph,
 * GCS interoperability) through a custom endpoint and path-style addressing.
 */
export class S3BlobProvider extends BlobProvider {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(params: {
    config: S3BlobProviderConfig;
    credentials: S3BlobProviderCredentials | null;
  }) {
    super(params.config.keyPrefix);
    this.bucket = params.config.bucket;
    this.client = new S3Client({
      region: params.config.region,
      endpoint: params.config.endpoint ?? undefined,
      forcePathStyle: params.config.forcePathStyle,
      credentials: s3Credentials(params.config, params.credentials),
    });
  }

  protected async putObject(params: {
    key: string;
    body: Buffer | string;
    contentType: string;
  }): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: params.key,
        Body: params.body,
        ContentType: params.contentType,
      }),
    );
  }

  protected async deleteObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  protected locationOf(key: string): string {
    return `s3://${this.bucket}/${key}`;
  }
}

// === internal ===

/**
 * The credentials an auth method resolves to. `undefined` hands resolution to
 * the AWS SDK default chain (env vars, web identity / IRSA / EKS Pod Identity,
 * container and instance roles, shared config files).
 */
function s3Credentials(
  config: S3BlobProviderConfig,
  credentials: S3BlobProviderCredentials | null,
): S3ClientConfig["credentials"] {
  switch (config.authMethod) {
    case "default_chain":
      return undefined;
    case "access_key":
      if (!credentials) {
        throw new Error("The access key auth method needs stored credentials");
      }
      return staticCredentials(credentials);
    case "assume_role":
      if (!config.roleArn) {
        throw new Error("The assume role auth method needs a role ARN");
      }
      return fromTemporaryCredentials({
        // No master credentials: the source identity is the default chain.
        masterCredentials: credentials
          ? staticCredentials(credentials)
          : undefined,
        params: {
          RoleArn: config.roleArn,
          RoleSessionName: ROLE_SESSION_NAME,
          ExternalId: config.externalId ?? undefined,
        },
        clientConfig: { region: config.region },
      });
  }
}

function staticCredentials(credentials: S3BlobProviderCredentials) {
  return {
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken,
  };
}

const ROLE_SESSION_NAME = "archestra-blob-provider";
