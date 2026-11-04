import { eq } from "drizzle-orm";
import config from "@/config";
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
    const [row] = await db.select().from(table).where(eq(table.id, id));
    return {
      ...(row ?? {
        id,
        enabled: false,
        unsupportedClientAction: "bypass" as const,
        breakTheGlassEnabled: true,
        annotatorModelId: null,
        annotatorLlmApiKeyId: null,
      }),
      // Release 1.4 sets these two in the environment: they are read-only here.
      humanApprovalMode: config.openappa.humanApprovalMode as HumanApprovalMode,
      unapprovableBlockMode: config.openappa
        .softBlockMode as UnapprovableBlockMode,
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
