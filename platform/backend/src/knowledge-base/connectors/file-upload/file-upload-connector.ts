import type { ConnectorCredentials, ConnectorSyncBatch } from "@/types";
import { BaseConnector } from "../base-connector";

export class FileUploadConnector extends BaseConnector {
  type = "file_upload" as const;

  async validateConfig(): Promise<{ valid: boolean }> {
    return { valid: true };
  }

  async testConnection(): Promise<{ success: boolean }> {
    return { success: true };
  }

  async *sync(_params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
  }): AsyncGenerator<ConnectorSyncBatch> {
    yield {
      documents: [],
      checkpoint: { type: "file_upload" as const },
      hasMore: false,
    };
  }
}
