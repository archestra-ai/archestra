import {
  type BlobProvider,
  describeBlobProviderError,
} from "@/blob-providers/blob-provider";
import { blobProviderDefinition } from "@/blob-providers/registry";
import logger from "@/logging";
import BlobProviderModel from "@/models/blob-provider";
import CostExportModel from "@/models/cost-export";
import { secretManager } from "@/secrets-manager";
import {
  ApiError,
  type BlobProviderConfig,
  type BlobProviderCredentials,
  BlobProviderCredentialsSchema,
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
    const rows = await BlobProviderModel.findByOrganization(organizationId);
    return rows.map(toPublic);
  }

  async get(params: {
    id: string;
    organizationId: string;
  }): Promise<PublicBlobProvider> {
    return toPublic(await this.require(params));
  }

  async create(params: {
    organizationId: string;
    data: CreateBlobProviderRequest;
  }): Promise<PublicBlobProvider> {
    const { organizationId, data } = params;
    await this.requireUniqueName({ organizationId, name: data.name });
    const credentials = this.credentialsFor(data.config, data.credentials);
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
    return toPublic(row);
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
    const usage = blobProviderDefinition(config).credentials(config);
    const keep = !data.clearCredentials && usage !== "unused";

    let secretId: string | null = keep ? existing.secretId : null;
    if (data.credentials && usage !== "unused") {
      const credentials = BlobProviderCredentialsSchema.parse(data.credentials);
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
    }
    if (usage === "required" && !secretId) {
      throw new ApiError(400, "This auth method needs credentials");
    }

    const updated = await BlobProviderModel.update(
      { id, organizationId },
      { name: data.name, config: data.config, secretId },
    );
    if (!updated) throw new ApiError(404, "Blob provider not found");
    if (existing.secretId && existing.secretId !== secretId) {
      await removeSecret(existing.secretId);
    }
    return toPublic(updated);
  }

  async delete(params: { id: string; organizationId: string }): Promise<void> {
    const existing = await this.require(params);
    const exports = await CostExportModel.countByBlobProvider(existing.id);
    if (exports > 0) {
      throw new ApiError(
        409,
        `This blob provider is used by ${exports} cost export(s). Delete or move those exports first.`,
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
    await this.require(params);
    try {
      const provider = await this.resolve(params);
      await provider.testConnection();
      return { success: true, message: "Wrote and deleted a test object." };
    } catch (error) {
      return { success: false, message: describeBlobProviderError(error) };
    }
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
    credentials: BlobProviderCredentials | undefined,
  ): BlobProviderCredentials | null {
    const usage = blobProviderDefinition(config).credentials(config);
    if (usage === "required" && !credentials) {
      throw new ApiError(400, "This auth method needs credentials");
    }
    return usage === "unused" ? null : (credentials ?? null);
  }
}

export const blobProviderService = new BlobProviderService();

// === internal ===

function toPublic(row: BlobProviderRow): PublicBlobProvider {
  const { secretId, ...rest } = row;
  return { ...rest, hasCredentials: secretId !== null };
}

function secretName(providerName: string): string {
  return `blob-provider-${providerName}`;
}

async function readCredentials(
  secretId: string,
): Promise<BlobProviderCredentials | null> {
  const secret = await secretManager().getSecret(secretId);
  const parsed = BlobProviderCredentialsSchema.safeParse(secret?.secret);
  return parsed.success ? parsed.data : null;
}

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
