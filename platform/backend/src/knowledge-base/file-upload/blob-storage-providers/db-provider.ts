import type { BlobStorageProvider, StoredBlobPointer } from "./types";

class DatabaseBlobStorageProvider implements BlobStorageProvider {
  readonly name = "db" as const;

  async put(params: { data: Buffer }): Promise<StoredBlobPointer> {
    return {
      provider: this.name,
      key: null,
      dbData: params.data,
    };
  }

  async get(params: { dbData: Buffer | null }): Promise<Buffer> {
    if (!params.dbData) {
      throw new Error("File bytes are not stored in the database");
    }
    return params.dbData;
  }

  async delete(): Promise<void> {
    return;
  }
}

export const databaseBlobStorageProvider = new DatabaseBlobStorageProvider();
