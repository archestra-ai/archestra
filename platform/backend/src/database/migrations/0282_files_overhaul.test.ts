import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0282_files_overhaul.sql"),
  "utf-8",
);

const statements = migrationSql
  .split("--> statement-breakpoint")
  .map((s) => s.trim());
// the backfill segment carries leading `-- Data migration` comment lines, so
// match on content rather than the first character.
const backfillStatement = statements.find((s) =>
  s.includes('INSERT INTO "files"'),
);
const dropStatement = statements.find((s) =>
  s.includes('DELETE FROM "skill_sandbox_files"'),
);

describe("0282 files backfill + artifact drop", () => {
  test("copies artifact rows verbatim, drops them, leaves uploads alone", async ({
    makeOrganization,
    makeUser,
  }) => {
    if (!backfillStatement || !dropStatement) {
      throw new Error("data statements not found in migration");
    }
    const user = await makeUser();
    const org = await makeOrganization();

    // a main-shaped sandbox + one artifact row + one upload row
    const [sandbox] = await db
      .insert(schema.skillSandboxesTable)
      .values({
        organizationId: org.id,
        userId: user.id,
        conversationId: null,
        defaultCwd: "/home/sandbox",
      })
      .returning();

    const artifactId = randomUUID();
    // raw SQL: the final Drizzle schema no longer models artifact rows'
    // shape, but the table still accepts them (kind is just text).
    await db.execute(sql`
      INSERT INTO skill_sandbox_files
        (id, kind, sandbox_id, path, mime_type, original_name, size_bytes, data)
      VALUES
        (${artifactId}, 'artifact', ${sandbox.id}, '/home/sandbox/out/report.csv',
         'text/csv', NULL, 4, ${Buffer.from("a,b\n")}),
        (${randomUUID()}, 'upload', ${sandbox.id}, '/home/sandbox/in.txt',
         'text/plain', 'in.txt', 2, ${Buffer.from("hi")})
    `);

    await db.execute(sql.raw(backfillStatement));
    await db.execute(sql.raw(dropStatement));

    const rows = await db
      .select()
      .from(schema.filesTable)
      .where(eq(schema.filesTable.id, artifactId));
    expect(rows).toHaveLength(1);
    const file = rows[0];
    expect(file.organizationId).toBe(org.id);
    expect(file.userId).toBe(user.id);
    expect(file.sandboxId).toBe(sandbox.id);
    expect(file.conversationId).toBeNull();
    expect(file.folderId).toBeNull();
    // filename = basename(path) because original_name was null
    expect(file.filename).toBe("report.csv");
    expect(file.mimeType).toBe("text/csv");
    expect(file.storageProvider).toBe("db");
    expect(file.objectKey).toBeNull();

    // the upload row survives; the artifact row is gone
    const leftover = await db
      .select()
      .from(schema.skillSandboxFilesTable)
      .where(eq(schema.skillSandboxFilesTable.sandboxId, sandbox.id));
    expect(leftover).toHaveLength(1);
    expect(leftover[0].kind).toBe("upload");

    // the upload was not copied into files
    const all = await db.select().from(schema.filesTable);
    expect(all.filter((f) => f.filename === "in.txt")).toHaveLength(0);
  });
});
