export type BlobStorageProviderName = "db" | "s3";

export type StoredBlobPointer = {
  provider: BlobStorageProviderName;
  key: string | null;
  dbData: Buffer | null;
};

export interface BlobStorageProvider {
  readonly name: BlobStorageProviderName;

  put(params: {
    organizationId: string;
    fileId: string;
    filename: string;
    mimeType: string;
    data: Buffer;
  }): Promise<StoredBlobPointer>;

  get(params: { key: string | null; dbData: Buffer | null }): Promise<Buffer>;

  delete(params: { key: string | null }): Promise<void>;
}
