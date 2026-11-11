import { GoogleAuth } from "google-auth-library";
import type {
  GcsBlobProviderConfig,
  GcsBlobProviderCredentials,
} from "@/types/blob-provider";
import { BlobProvider, describeBlobProviderError } from "./blob-provider";

/**
 * A Google Cloud Storage bucket, written through the Cloud Storage JSON API
 * with Application Default Credentials or a service account key.
 */
export class GcsBlobProvider extends BlobProvider {
  private readonly auth: GoogleAuth;
  private readonly bucket: string;

  constructor(params: {
    config: GcsBlobProviderConfig;
    credentials: GcsBlobProviderCredentials | null;
  }) {
    super(params.config.keyPrefix);
    this.bucket = params.config.bucket;
    this.auth = new GoogleAuth({
      scopes: [STORAGE_SCOPE],
      credentials:
        params.config.authMethod === "service_account_key"
          ? serviceAccountKey(params.credentials)
          : undefined,
    });
  }

  describeError(error: unknown): string {
    const gaxios = error as {
      status?: number;
      response?: {
        status?: number;
        data?: unknown;
      };
    };
    const status = gaxios.response?.status ?? gaxios.status;
    // Some failures come back with the JSON body still a string.
    const body = parseBody(gaxios.response?.data);
    const data = body?.error;
    const description = body?.error_description;
    if (typeof data === "string" && description) {
      // OAuth token endpoint: the key itself was refused.
      return `Google rejected the service account key: ${description} (${data}). Check that the key is current and not deleted.`;
    }
    const message = typeof data === "string" ? data : data?.message;
    if (status === 404) {
      return `Bucket "${this.bucket}" was not found. Check the bucket name.`;
    }
    if (status === 403 && message) {
      // Only a missing permission gets the grant hint; a 403 can also be a
      // disabled billing account or an org policy.
      return /does not have|permission/i.test(message)
        ? `${message} Grant it roles/storage.objectUser (or storage.objects.create and storage.objects.delete) on the bucket.`
        : `HTTP 403: ${message}`;
    }
    if (status === 401) {
      return `Google rejected the credentials (HTTP 401)${message ? `: ${message}` : "."}`;
    }
    if (message) return `HTTP ${status}: ${message}`;
    if (
      error instanceof Error &&
      error.message.includes("Could not load the default credentials")
    ) {
      return "No Application Default Credentials found on the server. Use Workload Identity, attach a service account, set GOOGLE_APPLICATION_CREDENTIALS, or switch to a service account key.";
    }
    return describeBlobProviderError(error);
  }

  protected async putObject(params: {
    key: string;
    body: Buffer | string;
    contentType: string;
  }): Promise<void> {
    const client = await this.auth.getClient();
    await client.request({
      url: `${API}/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o`,
      method: "POST",
      params: { uploadType: "media", name: params.key },
      headers: { "Content-Type": params.contentType },
      timeout: REQUEST_TIMEOUT_MS,
      body:
        typeof params.body === "string"
          ? params.body
          : new Uint8Array(params.body),
    });
  }

  protected async deleteObject(key: string): Promise<void> {
    const client = await this.auth.getClient();
    await client.request({
      url: `${API}/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(key)}`,
      method: "DELETE",
      timeout: REQUEST_TIMEOUT_MS,
    });
  }

  protected locationOf(key: string): string {
    return `gs://${this.bucket}/${key}`;
  }
}

// === internal ===

const API = "https://storage.googleapis.com";
const REQUEST_TIMEOUT_MS = 30_000;
const STORAGE_SCOPE = "https://www.googleapis.com/auth/devstorage.read_write";

type GoogleErrorBody = {
  error?: { message?: string } | string;
  error_description?: string;
};

function parseBody(data: unknown): GoogleErrorBody | undefined {
  if (typeof data === "string") {
    try {
      return JSON.parse(data) as GoogleErrorBody;
    } catch {
      return undefined;
    }
  }
  return data as GoogleErrorBody | undefined;
}

function serviceAccountKey(credentials: GcsBlobProviderCredentials | null) {
  if (!credentials) {
    throw new Error("The service account key auth method needs a stored key");
  }
  return JSON.parse(credentials.serviceAccountKey) as {
    client_email: string;
    private_key: string;
  };
}
