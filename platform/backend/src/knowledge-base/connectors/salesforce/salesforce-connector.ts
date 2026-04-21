import type {
  ConnectorCredentials,
  ConnectorSyncBatch,
  SalesforceConfig,
} from "@/types";
import { SalesforceConfigSchema } from "@/types";
import { BaseConnector } from "../base-connector";

export class SalesforceConnector extends BaseConnector {
  type = "salesforce" as const;

  async validateConfig(
    config: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    const parsed = parseSalesforceConfig(config);
    if (!parsed) {
      return {
        valid: false,
        error:
          "Invalid Salesforce configuration: loginUrl must be a URL and advancedObjectConfigJson must be valid JSON object text when provided",
      };
    }

    return { valid: true };
  }

  async testConnection(_params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
  }): Promise<{ success: boolean; error?: string }> {
    return {
      success: false,
      error:
        "Salesforce connector testConnection is not implemented yet (Phase 2)",
    };
  }

  async estimateTotalItems(_params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
  }): Promise<number | null> {
    return null;
  }

  async *sync(_params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
    startTime?: Date;
    endTime?: Date;
  }): AsyncGenerator<ConnectorSyncBatch> {
    throw new Error("Salesforce connector sync is not implemented yet (Phase 2)");
  }
}

// ===== Internal helpers =====

function parseSalesforceConfig(
  config: Record<string, unknown>,
): SalesforceConfig | null {
  const result = SalesforceConfigSchema.safeParse({
    type: "salesforce",
    loginUrl: "https://login.salesforce.com",
    ...config,
  });
  return result.success ? result.data : null;
}
