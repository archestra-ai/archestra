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
import { BlobProvider, describeBlobProviderError } from "./blob-provider";

/**
 * An Amazon S3 bucket, or any S3-compatible store (MinIO, Cloudflare R2, Ceph,
 * GCS interoperability) through a custom endpoint and path-style addressing.
 */
export class S3BlobProvider extends BlobProvider {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly config: S3BlobProviderConfig;

  constructor(params: {
    config: S3BlobProviderConfig;
    credentials: S3BlobProviderCredentials | null;
  }) {
    super(params.config.keyPrefix);
    this.bucket = params.config.bucket;
    this.config = params.config;
    this.client = new S3Client({
      region: params.config.region,
      endpoint: params.config.endpoint ?? undefined,
      forcePathStyle: params.config.forcePathStyle,
      // Fail fast on a hung endpoint instead of waiting out the SDK default.
      requestHandler: { connectionTimeout: 10_000, requestTimeout: 30_000 },
      credentials: s3Credentials(params.config, params.credentials),
    });
  }

  describeError(error: unknown): string {
    const e = error as Error & {
      Code?: string;
      Region?: string;
      Endpoint?: string;
      $metadata?: { httpStatusCode?: number };
    };
    const code = e.Code ?? e.name;
    if (/sts:AssumeRole|AssumeRole/.test(e.message ?? "")) {
      return `Could not assume ${this.config.roleArn}: ${e.message}`;
    }
    const where = `s3://${this.bucket}${this.config.keyPrefix ? `/${this.config.keyPrefix}` : ""}`;
    switch (code) {
      case "NoSuchBucket":
        return `Bucket "${this.bucket}" does not exist${this.config.endpoint ? ` at ${this.config.endpoint}` : ` in ${this.config.region}`}.`;
      case "PermanentRedirect":
      case "AuthorizationHeaderMalformed":
      case "IllegalLocationConstraintException":
        return `Bucket "${this.bucket}" is not in ${this.config.region}${e.Region ? `; it is in ${e.Region}` : ""}. Set the region to the bucket's region.`;
      case "AccessDenied":
        return `AccessDenied: the identity can't write to ${where}/. It needs s3:PutObject and s3:DeleteObject on arn:aws:s3:::${this.bucket}/${this.config.keyPrefix ? `${this.config.keyPrefix}/` : ""}*${e.message && e.message !== "Access Denied" ? ` (${e.message})` : ""}.`;
      case "InvalidAccessKeyId":
        return "InvalidAccessKeyId: AWS doesn't know this access key ID. Check it, or whether the key was deactivated.";
      case "SignatureDoesNotMatch":
        return "SignatureDoesNotMatch: the secret access key doesn't match the access key ID.";
      case "ExpiredToken":
      case "TokenRefreshRequired":
        return `${code}: the session token has expired. Store fresh credentials, or use a role instead of temporary keys.`;
      case "CredentialsProviderError":
        return "No AWS credentials found in the server's default chain (env vars, IRSA, EKS Pod Identity, instance role). Configure one, or use an access key.";
    }
    return describeBlobProviderError(error);
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
