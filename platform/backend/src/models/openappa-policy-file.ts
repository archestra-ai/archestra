import { createHash } from "node:crypto";
import { inArray } from "drizzle-orm";
import db, { schema } from "@/database";

const table = schema.openappaPolicyFilesTable;

/**
 * The policies roots opened under, as the runtime stored them: one row per
 * distinct document, addressed by its hash and never rewritten or deleted.
 * The runtime owns the table; the host only reads it: every hash when it
 * checks what the composition keeps, a document's bytes once per process.
 *
 * The ledger is deployment-wide. A deployment serves one organization, so
 * these rows are that organization's opening policies. Do not treat the table
 * as a multi-organization index.
 */
class OpenAppaPolicyFileModel {
  static async listHashes(): Promise<string[]> {
    const rows = await db.select({ hash: table.hash }).from(table);
    return rows.map((row) => row.hash);
  }

  /** The bytes of the named documents, read in chunks the driver accepts. */
  static async findByHashes(
    hashes: readonly string[],
  ): Promise<{ hash: string; bytes: Uint8Array }[]> {
    const rows: { hash: string; bytes: Uint8Array }[] = [];
    for (let start = 0; start < hashes.length; start += LOOKUP_CHUNK)
      rows.push(
        ...(await db
          .select({ hash: table.hash, bytes: table.bytes })
          .from(table)
          .where(
            inArray(table.hash, hashes.slice(start, start + LOOKUP_CHUNK)),
          )),
      );
    return rows;
  }

  /** Store a document as the runtime would, for tests that need an opened policy. */
  static async store(content: string): Promise<string> {
    const bytes = Buffer.from(content, "utf8");
    const hash = createHash("sha256").update(bytes).digest("hex");
    await db.insert(table).values({ hash, bytes }).onConflictDoNothing();
    return hash;
  }
}

/** Hashes per `IN` list, well under the driver's parameter limit. */
const LOOKUP_CHUNK = 500;

export default OpenAppaPolicyFileModel;
