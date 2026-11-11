import type { BlobProviderType } from "@archestra/shared";
import type {
  BlobProviderConfig,
  BlobProviderCredentials,
} from "@/types/blob-provider";
import type { BlobProvider } from "./blob-provider";
import { S3BlobProvider } from "./s3-blob-provider";

/** The registry entry for a configuration, typed by its `type`. */
export function blobProviderDefinition(
  config: BlobProviderConfig,
): BlobProviderDefinition<BlobProviderConfig> {
  return blobProviderRegistry[config.type] as BlobProviderDefinition<
    typeof config
  >;
}

// === internal ===

/**
 * Everything the platform needs to know about one provider type. Adding a
 * type is one entry here plus its `BlobProvider` subclass and config schema
 * (`types/blob-provider.ts`); the routes, secrets handling, and callers stay
 * the same.
 */
type BlobProviderDefinition<C extends BlobProviderConfig> = {
  create: (params: {
    config: C;
    credentials: BlobProviderCredentials | null;
  }) => BlobProvider;
  /** Whether this configuration authenticates with stored credentials. */
  credentials: (config: C) => "required" | "optional" | "unused";
};

type BlobProviderRegistry = {
  [T in BlobProviderType]: BlobProviderDefinition<
    Extract<BlobProviderConfig, { type: T }>
  >;
};

const blobProviderRegistry: BlobProviderRegistry = {
  s3: {
    create: ({ config, credentials }) =>
      new S3BlobProvider({ config, credentials }),
    credentials: (config) =>
      config.authMethod === "access_key"
        ? "required"
        : config.authMethod === "assume_role"
          ? "optional"
          : "unused",
  },
};
