import {
  AZURE_BLOB_AUTH_METHOD_LABELS,
  BLOB_PROVIDER_TYPE_LABELS,
  type BlobProviderType,
  GCS_AUTH_METHOD_LABELS,
  S3_AUTH_METHOD_LABELS,
} from "@archestra/shared";
import Image from "next/image";
import type { BlobProvider } from "@/lib/blob-provider.query";
import { cn } from "@/lib/utils/tailwind";

/** The provider type's mark, monochrome like the LLM provider logos. */
export function BlobProviderLogo({
  type,
  size = 16,
  className,
}: {
  type: BlobProviderType;
  size?: number;
  className?: string;
}) {
  return (
    <Image
      src={blobProviderLogoSrc(type)}
      alt={BLOB_PROVIDER_TYPE_LABELS[type]}
      width={size}
      height={size}
      className={cn("shrink-0 dark:invert", className)}
    />
  );
}

/** Path of the provider type's logo, for option labels that take a `src`. */
export function blobProviderLogoSrc(type: BlobProviderType): string {
  return BLOB_PROVIDER_LOGOS[type];
}

/**
 * Where a provider writes, as a URI (`s3://bucket/prefix/`), plus the custom
 * endpoint when there is one.
 */
export function blobProviderLocation(provider: BlobProvider): {
  uri: string;
  endpoint: string | null;
} {
  const { config } = provider;
  const prefix = config.keyPrefix ? `${config.keyPrefix}/` : "";
  switch (config.type) {
    case "s3":
      return {
        uri: `s3://${config.bucket}/${prefix}`,
        endpoint: config.endpoint,
      };
    case "gcs":
      return { uri: `gs://${config.bucket}/${prefix}`, endpoint: null };
    case "azure_blob":
      return {
        uri: `${config.endpoint ?? `https://${config.accountName}.blob.core.windows.net`}/${config.container}/${prefix}`,
        endpoint: null,
      };
  }
}

/** The short name of a provider's auth method. */
export function blobProviderAuthLabel(provider: BlobProvider): string {
  const { config } = provider;
  switch (config.type) {
    case "s3":
      return S3_AUTH_METHOD_LABELS[config.authMethod];
    case "gcs":
      return GCS_AUTH_METHOD_LABELS[config.authMethod];
    case "azure_blob":
      return AZURE_BLOB_AUTH_METHOD_LABELS[config.authMethod];
  }
}

const BLOB_PROVIDER_LOGOS: Record<BlobProviderType, string> = {
  s3: "/icons/blob-providers/s3.svg",
  gcs: "/icons/blob-providers/gcs.svg",
  azure_blob: "/icons/blob-providers/azure-blob.svg",
};
