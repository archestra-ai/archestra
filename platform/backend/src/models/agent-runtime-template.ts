import type { PopularAgentOverrides } from "@archestra/shared";
import { ApiError } from "@archestra/shared";
import { eq } from "drizzle-orm";
import db, { schema, type Transaction, withDbTransaction } from "@/database";
import type { Organization } from "@/types";
import type {
  RuntimeTemplateEditorSettings,
  RuntimeTemplateSettings,
} from "@/types/agent-runtime-template";
import { RuntimeTemplateSettingsSchema } from "@/types/agent-runtime-template";
import OrganizationModel from "./organization";
import SecretModel from "./secret";

class AgentRuntimeTemplateModel {
  static async getSettings(
    organizationId: string,
  ): Promise<RuntimeTemplateEditorSettings> {
    return withDbTransaction(async (tx) => {
      const [row] = await tx
        .select({
          popularAgentOverrides:
            schema.organizationsTable.popularAgentOverrides,
        })
        .from(schema.organizationsTable)
        .where(eq(schema.organizationsTable.id, organizationId))
        .for("share");
      if (!row) throw new ApiError(404, "Organization not found");
      return {
        ...(await AgentRuntimeTemplateModel.readStoredSettings(
          organizationId,
          tx,
        )),
        popularAgentOverrides: row.popularAgentOverrides ?? null,
      };
    });
  }

  static async saveSettings(params: {
    organizationId: string;
    settings: RuntimeTemplateSettings;
    popularAgentOverrides: PopularAgentOverrides | null;
  }): Promise<RuntimeTemplateEditorSettings> {
    const saved = await withDbTransaction(async (tx) => {
      const [row] = await tx
        .select({ id: schema.organizationsTable.id })
        .from(schema.organizationsTable)
        .where(eq(schema.organizationsTable.id, params.organizationId))
        .for("update");
      if (!row) throw new ApiError(404, "Organization not found");
      const current = await AgentRuntimeTemplateModel.readStoredSettings(
        params.organizationId,
        tx,
      );
      if (current.revision !== params.settings.revision)
        throw new ApiError(
          409,
          "Runtime templates changed. Reload the settings before saving again.",
        );
      const settings = {
        revision: params.settings.revision + 1,
        templates: params.settings.templates,
      };
      await AgentRuntimeTemplateModel.writeStoredSettings(
        params.organizationId,
        settings,
        tx,
      );
      await tx
        .update(schema.organizationsTable)
        .set({
          popularAgentOverrides: params.popularAgentOverrides,
        })
        .where(eq(schema.organizationsTable.id, params.organizationId));
      return settings;
    });
    await OrganizationModel.invalidateSettingsCaches(params.organizationId);
    return { ...saved, popularAgentOverrides: params.popularAgentOverrides };
  }

  /** Legacy catalog writes participate in the same revision lock. */
  static async updateIntegrationSettings(params: {
    organizationId: string;
    data: Partial<
      Pick<
        Organization,
        | "popularAgentOverrides"
        | "modelProviderOverrides"
        | "messagingChannelOverrides"
        | "knowledgeConnectorOverrides"
      >
    >;
  }) {
    const organization = await withDbTransaction(async (tx) => {
      const [row] = await tx
        .select({ id: schema.organizationsTable.id })
        .from(schema.organizationsTable)
        .where(eq(schema.organizationsTable.id, params.organizationId))
        .for("update");
      if (!row) return null;
      const settings = await AgentRuntimeTemplateModel.readStoredSettings(
        params.organizationId,
        tx,
      );
      await AgentRuntimeTemplateModel.writeStoredSettings(
        params.organizationId,
        {
          ...settings,
          revision: settings.revision + 1,
        },
        tx,
      );
      const [updated] = await tx
        .update(schema.organizationsTable)
        .set({
          ...params.data,
        })
        .where(eq(schema.organizationsTable.id, params.organizationId))
        .returning();
      return updated ?? null;
    });
    await OrganizationModel.invalidateSettingsCaches(params.organizationId);
    return organization;
  }

  /** Delete ciphertext directly; cleanup must also work when an encryption key is unavailable. */
  static async deleteForOrganization(organizationId: string): Promise<void> {
    await db
      .delete(schema.secretsTable)
      .where(
        eq(
          schema.secretsTable.name,
          AgentRuntimeTemplateModel.secretName(organizationId),
        ),
      );
  }

  static async findByIdForAudit(organizationId: string) {
    const settings =
      await AgentRuntimeTemplateModel.getSettings(organizationId);
    return {
      revision: settings.revision,
      popularAgentOverrides: settings.popularAgentOverrides,
      templates: settings.templates.map(({ runtime, ...template }) => ({
        ...template,
        icon: template.icon ? "(set)" : null,
        runtime: {
          ...runtime,
          environment:
            runtime.environment?.map(({ key }) => ({
              key,
              value: "[REDACTED]",
            })) ?? null,
        },
      })),
    };
  }

  // Private platform configuration uses the same encrypted database store as
  // ChatOps configuration. The organization row serializes first writes too.
  private static secretName(organizationId: string) {
    return `agent-runtime-templates:${organizationId}`;
  }

  private static async readStoredSettings(
    organizationId: string,
    tx: Transaction,
  ) {
    const row = await SecretModel.findByName(
      AgentRuntimeTemplateModel.secretName(organizationId),
      tx,
    );
    return row
      ? RuntimeTemplateSettingsSchema.parse(row.secret)
      : { revision: 0, templates: [] };
  }

  private static async writeStoredSettings(
    organizationId: string,
    settings: RuntimeTemplateSettings,
    tx: Transaction,
  ) {
    const name = AgentRuntimeTemplateModel.secretName(organizationId);
    const row = await SecretModel.findByName(name, tx);
    if (row) await SecretModel.update(row.id, { secret: settings }, tx);
    else await SecretModel.create({ name, secret: settings }, tx);
  }
}

export default AgentRuntimeTemplateModel;
