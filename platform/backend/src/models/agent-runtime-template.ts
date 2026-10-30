import type { PopularAgentOverrides } from "@archestra/shared";
import { ApiError } from "@archestra/shared";
import { eq } from "drizzle-orm";
import db, { schema, withDbTransaction } from "@/database";
import type { Organization } from "@/types";
import type {
  RuntimeTemplateEditorSettings,
  RuntimeTemplateSettings,
} from "@/types/agent-runtime-template";
import OrganizationModel from "./organization";

class AgentRuntimeTemplateModel {
  static async getSettings(
    organizationId: string,
  ): Promise<RuntimeTemplateEditorSettings> {
    const [row] = await db
      .select({
        settings: schema.organizationsTable.runtimeTemplateSettings,
        popularAgentOverrides: schema.organizationsTable.popularAgentOverrides,
      })
      .from(schema.organizationsTable)
      .where(eq(schema.organizationsTable.id, organizationId));
    if (!row) throw new ApiError(404, "Organization not found");
    return {
      ...(row.settings ?? { revision: 0, templates: [] }),
      popularAgentOverrides: row.popularAgentOverrides ?? null,
    };
  }

  static async saveSettings(params: {
    organizationId: string;
    settings: RuntimeTemplateSettings;
    popularAgentOverrides: PopularAgentOverrides | null;
  }): Promise<RuntimeTemplateEditorSettings> {
    const saved = await withDbTransaction(async (tx) => {
      const [row] = await tx
        .select({ settings: schema.organizationsTable.runtimeTemplateSettings })
        .from(schema.organizationsTable)
        .where(eq(schema.organizationsTable.id, params.organizationId))
        .for("update");
      if (!row) throw new ApiError(404, "Organization not found");
      if ((row.settings?.revision ?? 0) !== params.settings.revision)
        throw new ApiError(
          409,
          "Runtime templates changed. Reload the settings before saving again.",
        );
      const settings = {
        revision: params.settings.revision + 1,
        templates: params.settings.templates,
      };
      await tx
        .update(schema.organizationsTable)
        .set({
          runtimeTemplateSettings: settings,
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
        .select({ settings: schema.organizationsTable.runtimeTemplateSettings })
        .from(schema.organizationsTable)
        .where(eq(schema.organizationsTable.id, params.organizationId))
        .for("update");
      if (!row) return null;
      const settings = row.settings ?? { revision: 0, templates: [] };
      const [updated] = await tx
        .update(schema.organizationsTable)
        .set({
          ...params.data,
          runtimeTemplateSettings: {
            ...settings,
            revision: settings.revision + 1,
          },
        })
        .where(eq(schema.organizationsTable.id, params.organizationId))
        .returning(OrganizationModel.columns);
      return updated ?? null;
    });
    await OrganizationModel.invalidateSettingsCaches(params.organizationId);
    return organization;
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
}

export default AgentRuntimeTemplateModel;
