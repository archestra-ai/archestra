import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  NewSessionPolicy,
  UnsupportedAppaClientAction,
} from "@/types/guardrails-policy";

const table = schema.guardrailsDeploymentTable;
const id = "global";
class GuardrailsDeploymentModel {
  static async get() {
    const [row] = await db.select().from(table).where(eq(table.id, id));
    return (
      row ?? {
        id,
        enabled: false,
        unsupportedClientAction: "bypass" as const,
        breakTheGlassEnabled: true,
        newSessionPolicy: "live" as const,
        annotatorModelId: null,
        annotatorLlmApiKeyId: null,
      }
    );
  }
  static async isEnabled(): Promise<boolean> {
    return (await GuardrailsDeploymentModel.get()).enabled;
  }
  /** The policy new sessions decide under, read on its own for each dispatch. */
  static async getNewSessionPolicy(): Promise<NewSessionPolicy> {
    const [row] = await db
      .select({ newSessionPolicy: table.newSessionPolicy })
      .from(table)
      .where(eq(table.id, id));
    return row?.newSessionPolicy ?? "live";
  }
  static async setEnabled(enabled: boolean) {
    return GuardrailsDeploymentModel.set({ enabled });
  }
  static async set(update: {
    enabled?: boolean;
    unsupportedClientAction?: UnsupportedAppaClientAction;
    breakTheGlassEnabled?: boolean;
    newSessionPolicy?: NewSessionPolicy;
    annotatorModelId?: string | null;
    annotatorLlmApiKeyId?: string | null;
  }) {
    await db
      .insert(table)
      .values({ id, ...update })
      .onConflictDoUpdate({ target: table.id, set: update });
  }
  static async findByIdForAudit() {
    return GuardrailsDeploymentModel.get();
  }
}
export default GuardrailsDeploymentModel;
