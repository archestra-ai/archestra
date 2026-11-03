import { eq } from "drizzle-orm";
import { CacheKey, cacheManager } from "@/cache-manager";
import db, { schema } from "@/database";
import type {
  HumanApprovalMode,
  UnapprovableBlockMode,
  UnsupportedAppaClientAction,
} from "@/types/guardrails-policy";

const table = schema.guardrailsDeploymentTable;
const id = "global";
class GuardrailsDeploymentModel {
  static async get() {
    const [[row], modes] = await Promise.all([
      db.select().from(table).where(eq(table.id, id)),
      readBreakTheGlassModes(),
    ]);
    return {
      ...(row ?? {
        id,
        enabled: false,
        unsupportedClientAction: "bypass" as const,
        breakTheGlassEnabled: true,
        annotatorModelId: null,
        annotatorLlmApiKeyId: null,
      }),
      ...modes,
    };
  }
  static async isEnabled(): Promise<boolean> {
    return (await GuardrailsDeploymentModel.get()).enabled;
  }
  static async setEnabled(enabled: boolean) {
    return GuardrailsDeploymentModel.set({ enabled });
  }
  static async set(update: {
    enabled?: boolean;
    unsupportedClientAction?: UnsupportedAppaClientAction;
    breakTheGlassEnabled?: boolean;
    humanApprovalMode?: HumanApprovalMode;
    unapprovableBlockMode?: UnapprovableBlockMode;
    annotatorModelId?: string | null;
    annotatorLlmApiKeyId?: string | null;
  }) {
    const { humanApprovalMode, unapprovableBlockMode, ...columns } = update;
    if (humanApprovalMode || unapprovableBlockMode) {
      await cacheManager.set<BreakTheGlassModes>(
        CacheKey.BreakTheGlassSettings,
        {
          ...(await readBreakTheGlassModes()),
          ...(humanApprovalMode ? { humanApprovalMode } : {}),
          ...(unapprovableBlockMode ? { unapprovableBlockMode } : {}),
        },
        SETTINGS_TTL_MS,
      );
    }
    if (Object.keys(columns).length === 0) return;
    await db
      .insert(table)
      .values({ id, ...columns })
      .onConflictDoUpdate({ target: table.id, set: columns });
  }
  static async findByIdForAudit() {
    return GuardrailsDeploymentModel.get();
  }
}
export default GuardrailsDeploymentModel;

type BreakTheGlassModes = {
  humanApprovalMode: HumanApprovalMode;
  unapprovableBlockMode: UnapprovableBlockMode;
};

const DEFAULT_MODES: BreakTheGlassModes = {
  humanApprovalMode: "unattended",
  unapprovableBlockMode: "refuse",
};

/** The cache has no "never expires"; a century is the same in practice. */
const SETTINGS_TTL_MS = 100 * 365 * 24 * 60 * 60 * 1000;

/**
 * Release 1.4 keeps these two settings in the shared cache table instead of
 * guardrails_deployment columns, so it needs no schema change. Later
 * releases add the columns with the same defaults, so an unset value reads
 * the same before and after the upgrade.
 */
async function readBreakTheGlassModes(): Promise<BreakTheGlassModes> {
  const stored = await cacheManager.get<Partial<BreakTheGlassModes>>(
    CacheKey.BreakTheGlassSettings,
  );
  return { ...DEFAULT_MODES, ...(stored ?? {}) };
}
