import config from "@/config";
import { databaseBlobStorageProvider } from "./db-provider";
import { s3BlobStorageProvider } from "./s3-provider";
import type { BlobStorageProvider, BlobStorageProviderName } from "./types";

export function getConfiguredBlobStorageProvider(): BlobStorageProvider {
  return getBlobStorageProvider(config.kb.fileUpload.blobStorage.provider);
}

export function getBlobStorageProvider(
  provider: BlobStorageProviderName | string | null | undefined,
): BlobStorageProvider {
  if (provider === "s3") {
    return s3BlobStorageProvider;
  }

  return databaseBlobStorageProvider;
}
