import type { PopularAgentOverrides } from "@archestra/shared";
import {
  ApiError,
  sameAgentRuntimeTierName,
  TimeInMs,
} from "@archestra/shared";
import { eq } from "drizzle-orm";
import { LRUCacheManager } from "@/cache-manager";
import db, { schema, type Transaction, withDbTransaction } from "@/database";
import type { Organization } from "@/types";
import type {
  RuntimeTemplateEditorSettings,
  RuntimeTemplateSettings,
  RuntimeTemplateSettingsInput,
} from "@/types/agent-runtime-template";
import { RuntimeTemplateSettingsSchema } from "@/types/agent-runtime-template";
import OrganizationModel from "./organization";
import ResourcePermissionPolicyModel from "./resource-permission-policy";
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
        ...(await AgentRuntimeTemplateModel.readSettingsOnce(
          organizationId,
          tx,
        )),
        popularAgentOverrides: row.popularAgentOverrides ?? null,
      };
    });
  }

  static async saveSettings(params: {
    organizationId: string;
    settings: RuntimeTemplateSettingsInput;
    popularAgentOverrides: PopularAgentOverrides | null;
  }): Promise<RuntimeTemplateEditorSettings> {
    const input = RuntimeTemplateSettingsSchema.parse(params.settings);
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
      if (current.revision !== input.revision)
        throw new ApiError(
          409,
          "Runtime templates changed. Reload the settings before saving again.",
        );
      const settings = { ...input, revision: input.revision + 1 };
      await AgentRuntimeTemplateModel.writeStoredSettings(
        params.organizationId,
        settings,
        tx,
      );
      // A removed custom runtime takes its permissions with it, so a new one
      // can never inherit them.
      const kept = new Set(settings.templates.map(({ id }) => id));
      for (const { id } of current.templates) {
        if (kept.has(id)) continue;
        await ResourcePermissionPolicyModel.deleteForTarget({
          tx,
          resources: ["agentRuntime"],
          scope: id,
        });
      }
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
      builtIns: settings.builtIns,
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
  /** How many templates name `name` as their default or scaleup tier. */
  static async countRuntimeTierReferences(params: {
    organizationId: string;
    name: string;
  }): Promise<number> {
    const settings = await withDbTransaction((tx) =>
      AgentRuntimeTemplateModel.readStoredSettings(params.organizationId, tx),
    );
    return [
      ...settings.templates.map(({ runtime }) => runtime),
      ...Object.values(settings.builtIns).map((builtIn) => builtIn.settings),
    ].filter(
      (runtime) =>
        (runtime.tier && sameAgentRuntimeTierName(runtime.tier, params.name)) ||
        (runtime.maxTier &&
          sameAgentRuntimeTierName(runtime.maxTier, params.name)),
    ).length;
  }

  /**
   * Follow tier renames on every template that names one of them. Each stored
   * name is mapped once, whatever order the renames come in.
   */
  static async renameRuntimeTiers(params: {
    organizationId: string;
    renames: readonly { from: string; to: string }[];
    tx: Transaction;
  }): Promise<void> {
    if (params.renames.length === 0) return;
    const settings = await AgentRuntimeTemplateModel.readStoredSettings(
      params.organizationId,
      params.tx,
    );
    let changed = false;
    const renamed = <
      T extends { tier?: string | null; maxTier?: string | null },
    >(
      runtime: T,
    ): T => {
      const next = { ...runtime };
      for (const field of ["tier", "maxTier"] as const) {
        const name = next[field];
        const rename = name
          ? params.renames.find(({ from }) =>
              sameAgentRuntimeTierName(name, from),
            )
          : undefined;
        if (rename) {
          next[field] = rename.to;
          changed = true;
        }
      }
      return next;
    };
    const templates = settings.templates.map((template) => ({
      ...template,
      runtime: renamed(template.runtime),
    }));
    const builtIns = Object.fromEntries(
      Object.entries(settings.builtIns).map(([id, builtIn]) => [
        id,
        { ...builtIn, settings: renamed(builtIn.settings) },
      ]),
    );
    if (changed) {
      await AgentRuntimeTemplateModel.writeStoredSettings(
        params.organizationId,
        { ...settings, templates, builtIns },
        params.tx,
      );
    }
  }

  /**
   * Each organization's runtimes that were locked before runtime permissions
   * replaced locking, clearing the retired `locked` flags from its stored
   * settings. Used once, by the upgrade that turns them into permissions.
   */
  static async takeRetiredLocks(
    tx: Transaction,
  ): Promise<
    { organizationId: string; locked: Set<string>; templateIds: string[] }[]
  > {
    const organizations = await tx
      .select({ id: schema.organizationsTable.id })
      .from(schema.organizationsTable);
    const result = [];
    for (const { id } of organizations) {
      const row = await SecretModel.findByName(
        AgentRuntimeTemplateModel.secretName(id),
        tx,
      );
      if (!row) continue;
      const stored = row.secret as {
        templates?: { id: string; locked?: boolean }[];
        builtIns?: Record<string, { locked?: boolean } | undefined>;
      };
      const templates = stored.templates ?? [];
      const builtIns = Object.entries(stored.builtIns ?? {});
      const locked = new Set([
        ...templates.filter((item) => item.locked).map((item) => item.id),
        ...builtIns.filter(([, item]) => item?.locked).map(([key]) => key),
      ]);
      if (
        templates.some((item) => "locked" in item) ||
        builtIns.some(([, item]) => item && "locked" in item)
      )
        await AgentRuntimeTemplateModel.writeStoredSettings(
          id,
          RuntimeTemplateSettingsSchema.parse(stored),
          tx,
        );
      result.push({
        organizationId: id,
        locked,
        templateIds: templates.map((item) => item.id),
      });
    }
    return result;
  }

  /**
   * The stored settings, decrypted and parsed once for each change. A read
   * asks only when the secret last changed, so every replica sees a save at
   * once. They are kept in this process's memory and never in the shared
   * cache, which would store them outside their secret. What is returned is
   * shared between readers, so it is frozen.
   */
  private static async readSettingsOnce(
    organizationId: string,
    tx: Transaction,
  ): Promise<RuntimeTemplateSettings> {
    const name = AgentRuntimeTemplateModel.secretName(organizationId);
    const changedAt = await SecretModel.findUpdatedAtByName(name, tx);
    if (!changedAt) return AgentRuntimeTemplateModel.emptySettings();
    const cached = AgentRuntimeTemplateModel.settingsCache.get(organizationId);
    if (cached?.changedAt === changedAt.getTime()) return cached.settings;
    const row = await SecretModel.findByName(name, tx);
    if (!row) return AgentRuntimeTemplateModel.emptySettings();
    const settings = deepFreeze(
      RuntimeTemplateSettingsSchema.parse(row.secret),
    );
    AgentRuntimeTemplateModel.settingsCache.set(organizationId, {
      changedAt: row.updatedAt.getTime(),
      settings,
    });
    return settings;
  }

  private static readonly settingsCache = new LRUCacheManager<{
    changedAt: number;
    settings: RuntimeTemplateSettings;
  }>({ maxSize: 16, defaultTtl: TimeInMs.Day });

  private static emptySettings(): RuntimeTemplateSettings {
    return { revision: 0, templates: [], builtIns: {} };
  }

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
      : AgentRuntimeTemplateModel.emptySettings();
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

/** Freezes a parsed value and everything in it. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
