import type { BlobProvider } from "@/blob-providers/blob-provider";
import { blobProviderDefinition } from "@/blob-providers/registry";
import logger from "@/logging";
import BlobProviderModel from "@/models/blob-provider";
import CostExportModel from "@/models/cost-export";
import { secretManager } from "@/secrets-manager";
import {
  ApiError,
  type BlobProviderConfig,
  type BlobProviderCredentials,
  type BlobProviderRow,
  type CreateBlobProviderRequest,
  type PublicBlobProvider,
  type UpdateBlobProviderRequest,
} from "@/types";

/**
 * Organization blob providers: CRUD with credentials kept in the secrets
 * manager, and {@link BlobProviderService.resolve} for features that write
 * files. Features take a provider id and never see credentials.
 */
class BlobProviderService {
  async list(organizationId: string): Promise<PublicBlobProvider[]> {
    const [rows, exportNames] = await Promise.all([
      BlobProviderModel.findByOrganization(organizationId),
      CostExportModel.namesByBlobProvider(organizationId),
    ]);
    return rows.map((row) => toPublic(row, exportNames.get(row.id) ?? []));
  }

  async get(params: {
    id: string;
    organizationId: string;
  }): Promise<PublicBlobProvider> {
    return this.withUsage(await this.require(params));
  }

  async create(params: {
    organizationId: string;
    data: CreateBlobProviderRequest;
  }): Promise<PublicBlobProvider> {
    const { organizationId, data } = params;
    await this.requireUniqueName({ organizationId, name: data.name });
    const credentials = this.credentialsFor(data.config, data.credentials);
    if (!data.skipConnectionTest) {
      await this.requireWorking(data.config, credentials);
    }
    const secretId = credentials
      ? (await secretManager().createSecret(credentials, secretName(data.name)))
          .id
      : null;
    const row = await BlobProviderModel.create({
      organizationId,
      name: data.name,
      config: data.config,
      secretId,
    });
    return toPublic(row, []);
  }

  async update(params: {
    id: string;
    organizationId: string;
    data: UpdateBlobProviderRequest;
  }): Promise<PublicBlobProvider> {
    const { id, organizationId, data } = params;
    const existing = await this.require({ id, organizationId });
    if (data.name && data.name !== existing.name) {
      await this.requireUniqueName({ organizationId, name: data.name });
    }
    const config = data.config ?? existing.config;
    if (config.type !== existing.type) {
      throw new ApiError(400, "A blob provider's type cannot be changed");
    }
    const definition = blobProviderDefinition(config);
    const usage = definition.credentials(config);
    const authChanged =
      data.config !== undefined &&
      authKey(data.config) !== authKey(existing.config);

    // The credentials the saved configuration will use: new ones when sent,
    // else the stored ones, unless they were cleared, are not used, or belong
    // to a different auth method.
    let credentials: BlobProviderCredentials | null = null;
    if (usage !== "unused" && data.credentials) {
      credentials = definition.parseCredentials(config, data.credentials);
    } else if (
      usage !== "unused" &&
      !data.clearCredentials &&
      !authChanged &&
      existing.secretId
    ) {
      credentials = await readCredentials(existing.secretId);
    }
    if (usage === "required" && !credentials) {
      throw new ApiError(400, "This auth method needs credentials");
    }
    if (!data.skipConnectionTest && (data.config || data.credentials)) {
      await this.requireWorking(config, credentials);
    }

    let secretId: string | null = null;
    if (credentials && data.credentials) {
      if (existing.secretId) {
        await secretManager().updateSecret(existing.secretId, credentials);
        secretId = existing.secretId;
      } else {
        secretId = (
          await secretManager().createSecret(
            credentials,
            secretName(data.name ?? existing.name),
          )
        ).id;
      }
    } else if (credentials) {
      secretId = existing.secretId;
    }

    const updated = await BlobProviderModel.update(
      { id, organizationId },
      { name: data.name, config: data.config, secretId },
    );
    if (!updated) throw new ApiError(404, "Blob provider not found");
    if (existing.secretId && existing.secretId !== secretId) {
      await removeSecret(existing.secretId);
    }
    return this.withUsage(updated);
  }

  async delete(params: { id: string; organizationId: string }): Promise<void> {
    const existing = await this.require(params);
    const exports = await CostExportModel.countByBlobProvider(existing.id);
    if (exports > 0) {
      throw new ApiError(
        409,
        `This blob provider is used by ${exports} cost export(s). Delete those exports or move them to another provider first.`,
      );
    }
    await BlobProviderModel.delete(params);
    if (existing.secretId) await removeSecret(existing.secretId);
  }

  /** Write and delete a probe object with the stored configuration. */
  async test(params: {
    id: string;
    organizationId: string;
  }): Promise<{ success: boolean; message: string }> {
    // An unknown provider is a 404, not a failed test.
    const row = await this.require(params);
    const credentials = row.secretId
      ? await readCredentials(row.secretId)
      : null;
    const failure = await connectionFailure(row.config, credentials);
    return failure
      ? { success: false, message: failure }
      : { success: true, message: "Wrote and deleted a test object." };
  }

  /** A ready-to-use provider for a feature that writes files. */
  async resolve(params: {
    id: string;
    organizationId: string;
  }): Promise<BlobProvider> {
    const row = await this.require(params);
    const credentials = row.secretId
      ? await readCredentials(row.secretId)
      : null;
    return blobProviderDefinition(row.config).create({
      config: row.config,
      credentials,
    });
  }

  // === internal ===

  private async withUsage(row: BlobProviderRow): Promise<PublicBlobProvider> {
    const names = await CostExportModel.namesByBlobProvider(row.organizationId);
    return toPublic(row, names.get(row.id) ?? []);
  }

  private async require(params: {
    id: string;
    organizationId: string;
  }): Promise<BlobProviderRow> {
    const row = await BlobProviderModel.findById(params);
    if (!row) throw new ApiError(404, "Blob provider not found");
    return row;
  }

  private async requireUniqueName(params: {
    organizationId: string;
    name: string;
  }): Promise<void> {
    if (await BlobProviderModel.findByName(params)) {
      throw new ApiError(
        409,
        `A blob provider named "${params.name}" already exists`,
      );
    }
  }

  /** The credentials to store for a new configuration, validated. */
  private credentialsFor(
    config: BlobProviderConfig,
    raw: Record<string, string> | undefined,
  ): BlobProviderCredentials | null {
    const definition = blobProviderDefinition(config);
    const usage = definition.credentials(config);
    if (usage === "required" && !raw) {
      throw new ApiError(400, "This auth method needs credentials");
    }
    if (usage === "unused" || !raw) return null;
    return definition.parseCredentials(config, raw);
  }

  /** Reject a configuration that can't write and delete a test object. */
  private async requireWorking(
    config: BlobProviderConfig,
    credentials: BlobProviderCredentials | null,
  ): Promise<void> {
    const failure = await connectionFailure(config, credentials);
    if (failure) {
      throw new ApiError(400, failure, BLOB_PROVIDER_CONNECTION_FAILED_CODE);
    }
  }
}

export const blobProviderService = new BlobProviderService();

// === internal ===

function toPublic(
  row: BlobProviderRow,
  costExports: string[],
): PublicBlobProvider {
  const { secretId, ...rest } = row;
  return {
    ...rest,
    hasCredentials: secretId !== null,
    usedBy: { costExports },
  };
}

function secretName(providerName: string): string {
  return `blob-provider-${providerName}`;
}

async function readCredentials(
  secretId: string,
): Promise<BlobProviderCredentials | null> {
  const secret = await secretManager().getSecret(secretId);
  const value = secret?.secret;
  return value && typeof value === "object"
    ? (value as BlobProviderCredentials)
    : null;
}

/** Why a configuration can't write and delete a test object, or null. */
async function connectionFailure(
  config: BlobProviderConfig,
  credentials: BlobProviderCredentials | null,
): Promise<string | null> {
  let provider: BlobProvider;
  try {
    provider = blobProviderDefinition(config).create({ config, credentials });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  try {
    await provider.testConnection();
    return null;
  } catch (error) {
    logger.info(
      { err: error, type: config.type },
      "Blob provider connection test failed",
    );
    return provider.describeError(error);
  }
}

/** The fields that decide which identity a configuration authenticates as. */
function authKey(config: BlobProviderConfig): string {
  return JSON.stringify([config.type, config.authMethod]);
}

/** `internal_code` of a create or update rejected by its connection test. */
const BLOB_PROVIDER_CONNECTION_FAILED_CODE = "blob_provider_connection_failed";

async function removeSecret(secretId: string): Promise<void> {
  try {
    await secretManager().deleteSecret(secretId);
  } catch (error) {
    // The row no longer points at it; an orphaned secret is harmless.
    logger.warn(
      { err: error, secretId },
      "Failed to delete blob provider secret",
    );
  }
}
