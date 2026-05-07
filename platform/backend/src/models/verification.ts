import { eq } from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";
import logger from "@/logging";

class VerificationModel {
  static async create(params: {
    identifier: string;
    value: string;
    expiresAt: Date;
    tx?: Transaction;
  }) {
    logger.debug(
      { identifier: params.identifier },
      "VerificationModel.create: creating verification value",
    );
    const dbOrTx = params.tx ?? db;
    const [verification] = await dbOrTx
      .insert(schema.verificationsTable)
      .values({
        id: crypto.randomUUID(),
        identifier: params.identifier,
        value: params.value,
        expiresAt: params.expiresAt,
      })
      .returning();
    logger.debug(
      { identifier: params.identifier, created: !!verification },
      "VerificationModel.create: completed",
    );
    return verification;
  }

  static async getByIdentifier(identifier: string, tx?: Transaction) {
    logger.debug(
      { identifier },
      "VerificationModel.getByIdentifier: fetching verification value",
    );
    const dbOrTx = tx ?? db;
    const query = dbOrTx
      .select()
      .from(schema.verificationsTable)
      .where(eq(schema.verificationsTable.identifier, identifier))
      .limit(1);
    const [verification] = await (tx ? query.for("update") : query);
    logger.debug(
      { identifier, found: !!verification },
      "VerificationModel.getByIdentifier: completed",
    );
    return verification ?? null;
  }

  static async deleteByIdentifier(identifier: string, tx?: Transaction) {
    logger.debug(
      { identifier },
      "VerificationModel.deleteByIdentifier: deleting verification value",
    );
    const dbOrTx = tx ?? db;
    const deleted = await dbOrTx
      .delete(schema.verificationsTable)
      .where(eq(schema.verificationsTable.identifier, identifier))
      .returning({ id: schema.verificationsTable.id });
    logger.debug(
      { identifier, count: deleted.length },
      "VerificationModel.deleteByIdentifier: completed",
    );
    return deleted.length;
  }
}

export default VerificationModel;
