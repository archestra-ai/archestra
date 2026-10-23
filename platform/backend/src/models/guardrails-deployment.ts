import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { PreparedQuery } from "@/database/prepared-query";
import type { UnsupportedAppaClientAction } from "@/types/guardrails-policy";

const table = schema.guardrailsDeploymentTable;
const id = "global";
class GuardrailsDeploymentModel {
  static async get() {
    const [row] = await GuardrailsDeploymentModel.read.get().execute();
    return (
      row ?? {
        id,
        enabled: false,
        unsupportedClientAction: "bypass" as const,
        breakTheGlassEnabled: true,
        annotatorModelId: null,
        annotatorLlmApiKeyId: null,
      }
    );
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

  private static readonly read = new PreparedQuery((database) =>
    database
      .select()
      .from(table)
      .where(eq(table.id, id))
      .prepare("archestra_guardrails_deployment"),
  );
}
export default GuardrailsDeploymentModel;
