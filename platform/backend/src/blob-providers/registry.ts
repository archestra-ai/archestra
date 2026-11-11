import type { BlobProviderType } from "@archestra/shared";
import type { z } from "zod";
import {
  ApiError,
  type AzureBlobProviderConfig,
  AzureBlobProviderCredentialsSchema,
  type BlobProviderConfig,
  type BlobProviderCredentials,
  type GcsBlobProviderConfig,
  GcsBlobProviderCredentialsSchema,
  type S3BlobProviderConfig,
  S3BlobProviderCredentialsSchema,
} from "@/types";
import { AzureBlobProvider } from "./azure-blob-provider";
import type { BlobProvider } from "./blob-provider";
import { GcsBlobProvider } from "./gcs-blob-provider";
import { S3BlobProvider } from "./s3-blob-provider";

/** The registry entry for a configuration, typed by its `type`. */
export function blobProviderDefinition(
  config: BlobProviderConfig,
): BlobProviderDefinition<BlobProviderConfig, BlobProviderCredentials> {
  return blobProviderRegistry[config.type] as unknown as BlobProviderDefinition<
    BlobProviderConfig,
    BlobProviderCredentials
  >;
}

// === internal ===

/**
 * Everything the platform needs to know about one provider type. Adding a
 * type is one entry here plus its `BlobProvider` subclass and config and
 * credentials schemas (`types/blob-provider.ts`); the routes, secrets
 * handling, and callers stay the same.
 */
type BlobProviderDefinition<C extends BlobProviderConfig, K> = {
  create: (params: { config: C; credentials: K | null }) => BlobProvider;
  /** Whether this configuration authenticates with stored credentials. */
  credentials: (config: C) => "required" | "optional" | "unused";
  /**
   * Validate credentials a request sent (or a stored secret) for this
   * configuration. Throws a 400 naming what is missing or malformed.
   */
  parseCredentials: (config: C, raw: unknown) => K;
};

type BlobProviderRegistry = {
  [T in BlobProviderType]: BlobProviderDefinition<
    Extract<BlobProviderConfig, { type: T }>,
    // biome-ignore lint/suspicious/noExplicitAny: each entry narrows its own credentials type.
    any
  >;
};

const blobProviderRegistry: BlobProviderRegistry = {
  s3: {
    create: ({ config, credentials }) =>
      new S3BlobProvider({ config, credentials }),
    credentials: (config: S3BlobProviderConfig) =>
      config.authMethod === "access_key"
        ? "required"
        : config.authMethod === "assume_role"
          ? "optional"
          : "unused",
    parseCredentials: (_config, raw) =>
      parseWith(S3BlobProviderCredentialsSchema, raw),
  },
  gcs: {
    create: ({ config, credentials }) =>
      new GcsBlobProvider({ config, credentials }),
    credentials: (config: GcsBlobProviderConfig) =>
      config.authMethod === "service_account_key" ? "required" : "unused",
    parseCredentials: (_config, raw) =>
      parseWith(GcsBlobProviderCredentialsSchema, raw),
  },
  azure_blob: {
    create: ({ config, credentials }) =>
      new AzureBlobProvider({ config, credentials }),
    credentials: (config: AzureBlobProviderConfig) =>
      config.authMethod === "default_credential" ? "unused" : "required",
    parseCredentials: (config: AzureBlobProviderConfig, raw) => {
      const credentials = parseWith(AzureBlobProviderCredentialsSchema, raw);
      const field = AZURE_SECRET_FIELD[config.authMethod];
      if (field && !credentials[field.key]) {
        throw new ApiError(400, `${field.label} is required`);
      }
      // Keep only the secret the auth method uses.
      return field ? { [field.key]: credentials[field.key] } : {};
    },
  },
};

const AZURE_SECRET_FIELD: Record<
  AzureBlobProviderConfig["authMethod"],
  { key: "clientSecret" | "accountKey" | "sasToken"; label: string } | null
> = {
  default_credential: null,
  service_principal: { key: "clientSecret", label: "Client secret" },
  account_key: { key: "accountKey", label: "Account key" },
  sas_token: { key: "sasToken", label: "SAS token" },
};

function parseWith<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid credentials",
    );
  }
  return parsed.data;
}
