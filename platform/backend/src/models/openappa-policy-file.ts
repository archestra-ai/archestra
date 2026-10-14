import { createHash } from "node:crypto";
import db, { schema } from "@/database";

const table = schema.openappaPolicyFilesTable;

/**
 * The policies roots opened under, as the runtime stored them: one row per
 * distinct document, addressed by its hash and never rewritten or deleted.
 * The runtime owns the table; the host only reads it.
 *
 * The ledger is deployment-wide. A deployment serves one organization, so
 * these rows are that organization's opening policies. Do not treat the table
 * as a multi-organization index.
 */
class OpenAppaPolicyFileModel {
  static async list(): Promise<{ hash: string; bytes: Uint8Array }[]> {
    return db.select({ hash: table.hash, bytes: table.bytes }).from(table);
  }

  /** Store a document as the runtime would, for tests that need an opened policy. */
  static async store(content: string): Promise<string> {
    const bytes = Buffer.from(content, "utf8");
    const hash = createHash("sha256").update(bytes).digest("hex");
    await db.insert(table).values({ hash, bytes }).onConflictDoNothing();
    return hash;
  }
}

export default OpenAppaPolicyFileModel;
