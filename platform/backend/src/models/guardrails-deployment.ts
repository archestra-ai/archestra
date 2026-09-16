import { eq } from "drizzle-orm";
import db, { schema } from "@/database";

const table = schema.guardrailsDeploymentTable;
const id = "global";
class GuardrailsDeploymentModel {
  static async isEnabled(): Promise<boolean> {
    const [row] = await db.select().from(table).where(eq(table.id, id));
    return row?.enabled ?? false;
  }
  static async setEnabled(enabled: boolean) {
    await db
      .insert(table)
      .values({ id, enabled })
      .onConflictDoUpdate({ target: table.id, set: { enabled } });
  }
  static async findByIdForAudit() {
    return { id, enabled: await GuardrailsDeploymentModel.isEnabled() };
  }
}
export default GuardrailsDeploymentModel;
