import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { PreparedQuery } from "@/database/prepared-query";
import type { GuardrailsMode } from "@/types/guardrails-policy";

const table = schema.guardrailsDeploymentTable;
const id = "global";
type GuardrailsDeploymentRow = typeof table.$inferSelect;
export type GuardrailsDeploymentUpdate = Partial<
  Omit<typeof table.$inferInsert, "id">
>;
class GuardrailsDeploymentModel {
  static async get(snapshot?: { row: typeof table.$inferSelect | null }) {
    const row = snapshot
      ? snapshot.row
      : (await GuardrailsDeploymentModel.read.get().execute())[0];
    return (
      row ?? {
        id,
        mode: null,
        personApproval: null,
        enforcedMarks: null,
        enabled: false,
        unsupportedClientAction: "bypass" as const,
        breakTheGlassEnabled: true,
        humanApprovalMode: "block" as const,
        unapprovableBlockMode: "refuse" as const,
        annotatorModelId: null,
        annotatorLlmApiKeyId: null,
      }
    );
  }

  /** The saved mode, else the one the legacy switch derives. */
  static mode(row: GuardrailsDeploymentRow): GuardrailsMode {
    return row.mode ?? (row.enabled ? "enforce" : "off");
  }
  static async isEnabled(): Promise<boolean> {
    return (
      GuardrailsDeploymentModel.mode(await GuardrailsDeploymentModel.get()) !==
      "off"
    );
  }
  /** The legacy switch alone: the mode derives from it again. */
  static async setEnabled(enabled: boolean) {
    return GuardrailsDeploymentModel.set({ enabled, mode: null });
  }
  static async set(update: GuardrailsDeploymentUpdate) {
    await db
      .insert(table)
      .values({ id, ...update })
      .onConflictDoUpdate({ target: table.id, set: update });
  }
  static async findByIdForAudit() {
    return GuardrailsDeploymentModel.get();
  }

  private static readonly read = new PreparedQuery((database) =>
    database
      .select()
      .from(table)
      .where(eq(table.id, id))
      .prepare("archestra_guardrails_deployment"),
  );
}
export default GuardrailsDeploymentModel;
