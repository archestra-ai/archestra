import { and, eq, isNull } from "drizzle-orm";
import db, { schema, withDbTransaction } from "@/database";
import { PreparedQuery } from "@/database/prepared-query";
import type { Transaction } from "@/database/schema";
import type { GuardrailsMode } from "@/types/guardrails-policy";

const table = schema.guardrailsDeploymentTable;
const id = "global";
export type GuardrailsDeploymentRow = typeof table.$inferSelect;
export type GuardrailsDeploymentUpdate = Partial<
  Omit<typeof table.$inferInsert, "id">
>;
class GuardrailsDeploymentModel {
  static async get(snapshot?: { row: GuardrailsDeploymentRow | null }) {
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

  /**
   * `enabled` is the on/off bit, which a replica of an older release may
   * write alone. On is Observe only while the saved mode and the legacy
   * columns both say so; a disagreement reads as the stricter Enforce.
   */
  static mode(row: GuardrailsDeploymentRow): GuardrailsMode {
    if (!row.enabled) return "off";
    const legacyObserve =
      row.humanApprovalMode === "everywhere" &&
      row.unapprovableBlockMode === "allow";
    return row.mode === "observe" && legacyObserve ? "observe" : "enforce";
  }
  static async isEnabled(): Promise<boolean> {
    return (await GuardrailsDeploymentModel.get()).enabled;
  }
  static async setEnabled(enabled: boolean) {
    return GuardrailsDeploymentModel.set({ enabled });
  }
  static async set(update: GuardrailsDeploymentUpdate) {
    await db
      .insert(table)
      .values({ id, ...update })
      .onConflictDoUpdate({ target: table.id, set: update });
  }

  /**
   * Write what `next` derives from the row, holding the row's lock from the
   * read to the write. Returns the row as this save found and left it.
   */
  static async save(
    next: (row: GuardrailsDeploymentRow) => GuardrailsDeploymentUpdate,
  ): Promise<{
    before: GuardrailsDeploymentRow;
    after: GuardrailsDeploymentRow;
  }> {
    return withDbTransaction(async (tx) => {
      await tx.insert(table).values({ id }).onConflictDoNothing();
      const [before] = await tx
        .select()
        .from(table)
        .where(eq(table.id, id))
        .for("update");
      const [after] = await tx
        .update(table)
        .set(next(before))
        .where(eq(table.id, id))
        .returning();
      return { before, after };
    });
  }

  /**
   * Switch on in Enforce while no mode was ever saved and the switch is off,
   * in one conditional write. Whether it wrote.
   */
  static async turnOnIfNeverSet(): Promise<boolean> {
    const set = { mode: "enforce" as const, enabled: true };
    const written = await db
      .insert(table)
      .values({ id, ...set })
      .onConflictDoUpdate({
        target: table.id,
        set,
        setWhere: and(isNull(table.mode), eq(table.enabled, false)),
      })
      .returning({ id: table.id });
    return written.length > 0;
  }

  /** Back to first-run settings: no row, so every column reads its default. */
  static async reset(tx: Transaction) {
    await tx.delete(table);
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
