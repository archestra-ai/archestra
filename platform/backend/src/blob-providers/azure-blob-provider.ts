import {
  ClientSecretCredential,
  DefaultAzureCredential,
} from "@azure/identity";
import {
  AnonymousCredential,
  ContainerClient,
  type StoragePipelineOptions,
  StorageSharedKeyCredential,
} from "@azure/storage-blob";
import type {
  AzureBlobProviderConfig,
  AzureBlobProviderCredentials,
} from "@/types/blob-provider";
import { BlobProvider, describeBlobProviderError } from "./blob-provider";

/**
 * An Azure Blob Storage container, with the default Azure credential, a
 * service principal, a storage account key, or a SAS token.
 */
export class AzureBlobProvider extends BlobProvider {
  private readonly container: ContainerClient;
  private readonly config: AzureBlobProviderConfig;

  constructor(params: {
    config: AzureBlobProviderConfig;
    credentials: AzureBlobProviderCredentials | null;
  }) {
    super(params.config.keyPrefix);
    this.config = params.config;
    this.container = containerClient(params.config, params.credentials);
  }

  describeError(error: unknown): string {
    const e = error as Error & {
      code?: string;
      statusCode?: number;
      details?: { errorCode?: string };
    };
    const code = e.details?.errorCode ?? e.code;
    const { accountName, container } = this.config;
    switch (code) {
      case "ContainerNotFound":
        return `Container "${container}" does not exist in storage account "${accountName}".`;
      case "AuthorizationPermissionMismatch":
      case "AuthorizationFailure":
        return `${code}: the identity can't write blobs in "${container}". Assign it the Storage Blob Data Contributor role on the container or account${this.config.authMethod === "sas_token" ? ", or issue a SAS token with create, write and delete permissions" : ""}.`;
      case "AuthenticationFailed":
        return `AuthenticationFailed: Azure rejected the ${this.config.authMethod === "sas_token" ? "SAS token (expired, or signed for another resource?)" : this.config.authMethod === "account_key" ? "account key" : "credentials"}.`;
      case "ENOTFOUND":
        return `Could not resolve ${serviceUrl(this.config)}. Check the storage account name${this.config.endpoint ? " and endpoint" : ""}.`;
    }
    if (e.name === "CredentialUnavailableError") {
      return "No Azure credential found on the Archestra server. Use AKS Workload Identity or a managed identity, set AZURE_CLIENT_ID / AZURE_TENANT_ID / AZURE_CLIENT_SECRET, or pick another auth method.";
    }
    if (
      e.name === "AuthenticationError" ||
      e.name === "AggregateAuthenticationError"
    ) {
      return `Microsoft Entra sign-in failed: ${entraReason(e.message)}`;
    }
    if (/AADSTS\d+/.test(e.message ?? "")) {
      return `Microsoft Entra sign-in failed: ${entraReason(e.message)}`;
    }
    if (code && e.message) {
      return `${code}${e.statusCode ? `, HTTP ${e.statusCode}` : ""}: ${firstLine(e.message)}`;
    }
    return describeBlobProviderError(error);
  }

  protected async putObject(params: {
    key: string;
    body: Buffer | string;
    contentType: string;
  }): Promise<void> {
    const body =
      typeof params.body === "string" ? Buffer.from(params.body) : params.body;
    await this.container
      .getBlockBlobClient(params.key)
      .upload(body, body.byteLength, {
        blobHTTPHeaders: { blobContentType: params.contentType },
      });
  }

  protected async deleteObject(key: string): Promise<void> {
    await this.container.getBlockBlobClient(key).delete();
  }

  protected locationOf(key: string): string {
    // Never the client URL itself: with a SAS token it carries the signature.
    return `${containerBaseUrl(this.config)}/${key}`;
  }
}

// === internal ===

/**
 * Bounded retries: the SDK default retries an unreachable account for
 * minutes, which a connection test (and a scheduled run) should not wait out.
 */
const PIPELINE: StoragePipelineOptions = {
  retryOptions: {
    maxTries: 2,
    tryTimeoutInMs: 30_000,
    maxRetryDelayInMs: 2_000,
  },
};

function serviceUrl(config: AzureBlobProviderConfig): string {
  return (
    config.endpoint ?? `https://${config.accountName}.blob.core.windows.net`
  );
}

function containerBaseUrl(config: AzureBlobProviderConfig): string {
  return `${serviceUrl(config)}/${config.container}`;
}

/** The `AADSTS…` sentence of an Entra error, without trace and correlation IDs. */
function entraReason(message: string): string {
  const match = message.match(/AADSTS\d+:[^.]*\./);
  return match ? match[0] : firstLine(message);
}

function containerClient(
  config: AzureBlobProviderConfig,
  credentials: AzureBlobProviderCredentials | null,
): ContainerClient {
  const url = containerBaseUrl(config);
  switch (config.authMethod) {
    case "default_credential":
      return new ContainerClient(url, new DefaultAzureCredential(), PIPELINE);
    case "service_principal":
      if (!config.tenantId || !config.clientId || !credentials?.clientSecret) {
        throw new Error(
          "The service principal auth method needs a tenant ID, client ID and client secret",
        );
      }
      return new ContainerClient(
        url,
        new ClientSecretCredential(
          config.tenantId,
          config.clientId,
          credentials.clientSecret,
        ),
        PIPELINE,
      );
    case "account_key":
      if (!credentials?.accountKey) {
        throw new Error("The account key auth method needs a stored key");
      }
      return new ContainerClient(
        url,
        new StorageSharedKeyCredential(
          config.accountName,
          credentials.accountKey,
        ),
        PIPELINE,
      );
    case "sas_token":
      if (!credentials?.sasToken) {
        throw new Error("The SAS token auth method needs a stored token");
      }
      return new ContainerClient(
        `${url}?${credentials.sasToken}`,
        new AnonymousCredential(),
        PIPELINE,
      );
  }
}

function firstLine(message: string): string {
  return message.split("\n")[0].trim();
}
