import { and, isNotNull, not } from "drizzle-orm";
import db, { schema } from "@/database";
import type { ParsedSearchText } from "@/types/tool-search-text";
import { idArrayCondition } from "./id-array-condition";

type ToolSearchTextAttempt = {
  definitionHash: string;
  promptVersion: number;
  generator: string;
  result: ParsedSearchText;
};

class ToolSearchTextModel {
  static async findTextsByHashes(
    hashes: string[],
  ): Promise<Map<string, string>> {
    if (hashes.length === 0) return new Map();
    const rows = await db
      .select({
        definitionHash: schema.toolSearchTextsTable.definitionHash,
        searchText: schema.toolSearchTextsTable.searchText,
      })
      .from(schema.toolSearchTextsTable)
      .where(
        and(
          idArrayCondition(schema.toolSearchTextsTable.definitionHash, hashes),
          isNotNull(schema.toolSearchTextsTable.searchText),
        ),
      );
    return new Map(
      rows.flatMap((row) =>
        row.searchText === null
          ? []
          : [[row.definitionHash, row.searchText] as const],
      ),
    );
  }

  static async findAttempts() {
    return await db
      .select({
        definitionHash: schema.toolSearchTextsTable.definitionHash,
        status: schema.toolSearchTextsTable.status,
        promptVersion: schema.toolSearchTextsTable.promptVersion,
        generator: schema.toolSearchTextsTable.generator,
        updatedAt: schema.toolSearchTextsTable.updatedAt,
      })
      .from(schema.toolSearchTextsTable);
  }

  static async recordAttempt(attempt: ToolSearchTextAttempt): Promise<void> {
    const { definitionHash, generator, promptVersion, result } = attempt;
    const searchText = result.status === "ready" ? result.searchText : null;
    const attemptColumns = {
      status: result.status,
      promptVersion,
      generator,
      updatedAt: new Date(),
    };
    await db
      .insert(schema.toolSearchTextsTable)
      .values({ definitionHash, searchText, ...attemptColumns })
      .onConflictDoUpdate({
        target: schema.toolSearchTextsTable.definitionHash,
        set:
          result.status === "failed"
            ? attemptColumns
            : { searchText, ...attemptColumns },
      });
  }

  static async deleteExcept(hashes: string[]): Promise<void> {
    await db
      .delete(schema.toolSearchTextsTable)
      .where(
        not(
          idArrayCondition(schema.toolSearchTextsTable.definitionHash, hashes),
        ),
      );
  }

  static async countWithText(): Promise<number> {
    return await db.$count(
      schema.toolSearchTextsTable,
      isNotNull(schema.toolSearchTextsTable.searchText),
    );
  }
}

export default ToolSearchTextModel;
