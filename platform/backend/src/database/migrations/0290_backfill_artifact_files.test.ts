import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0290_backfill_artifact_files.sql"),
  "utf-8",
);

// Migration statements split on the breakpoint, with comment lines stripped.
const STATEMENTS = migrationSql
  .split("--> statement-breakpoint")
  .map((chunk) =>
    chunk
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .trim(),
  )
  .filter((chunk) => chunk.length > 0);

// The standard PGlite harness applies ALL migrations at setup before any data
// exists, so a migration-time backfill cannot be observed by seeding then
// migrating. Instead we re-run the migration's own SQL against a seeded state.
async function runBackfill(): Promise<void> {
  for (const statement of STATEMENTS) {
    await db.execute(sql.raw(statement));
  }
}

async function makeSandbox(opts: {
  organizationId: string;
  userId: string;
  conversationId: string;
}) {
  const [sandbox] = await db
    .insert(schema.skillSandboxesTable)
    .values({
      organizationId: opts.organizationId,
      userId: opts.userId,
      conversationId: opts.conversationId,
      isDefault: true,
      defaultCwd: "/home/sandbox",
    })
    .returning();
  return sandbox;
}

async function makeArtifactFile(opts: {
  sandboxId: string;
  path: string;
  originalName: string | null;
  mimeType: string;
  data: Buffer;
}) {
  const [file] = await db
    .insert(schema.skillSandboxFilesTable)
    .values({
      kind: "artifact",
      sandboxId: opts.sandboxId,
      path: opts.path,
      mimeType: opts.mimeType,
      originalName: opts.originalName,
      sizeBytes: opts.data.byteLength,
      data: opts.data,
    })
    .returning();
  return file;
}

describe("0290 migration: backfill kind='artifact' rows into files", () => {
  test("copies an artifact into files (same id, sandbox provenance), drops the source row", async ({
    makeUser,
    makeOrganization,
    makeAgent,
    makeConversation,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });
    const conversation = await makeConversation(agent.id, {
      organizationId: org.id,
      userId: user.id,
    });
    const sandbox = await makeSandbox({
      organizationId: org.id,
      userId: user.id,
      conversationId: conversation.id,
    });

    const data = Buffer.from("report contents");
    const artifact = await makeArtifactFile({
      sandboxId: sandbox.id,
      path: "/home/sandbox/output/report.csv",
      originalName: "report.csv",
      mimeType: "text/csv",
      data,
    });

    await runBackfill();

    const files = await db
      .select()
      .from(schema.filesTable)
      .where(eq(schema.filesTable.id, artifact.id));
    expect(files).toHaveLength(1);
    const file = files[0];
    // Reuses the source id so existing `/api/skill-sandbox/artifacts/:id` refs hold.
    expect(file.id).toBe(artifact.id);
    expect(file.filename).toBe("report.csv");
    expect(file.mimeType).toBe("text/csv");
    expect(file.sizeBytes).toBe(data.byteLength);
    expect(Buffer.from(file.data as Buffer).toString()).toBe("report contents");
    // Provenance comes from the producing sandbox.
    expect(file.organizationId).toBe(org.id);
    expect(file.userId).toBe(user.id);
    expect(file.conversationId).toBe(conversation.id);
    expect(file.sandboxId).toBe(sandbox.id);
    // Artifacts predate projects.
    expect(file.projectId).toBeNull();
    // Postgres-only storage (satisfies files_storage_payload_chk).
    expect(file.storageProvider).toBe("db");
    expect(file.objectKey).toBeNull();

    // The source artifact row is removed (guarded delete confirmed the copy).
    const remaining = await db
      .select()
      .from(schema.skillSandboxFilesTable)
      .where(eq(schema.skillSandboxFilesTable.id, artifact.id));
    expect(remaining).toHaveLength(0);
  });

  test("derives filename from the path basename when original_name is NULL", async ({
    makeUser,
    makeOrganization,
    makeAgent,
    makeConversation,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });
    const conversation = await makeConversation(agent.id, {
      organizationId: org.id,
      userId: user.id,
    });
    const sandbox = await makeSandbox({
      organizationId: org.id,
      userId: user.id,
      conversationId: conversation.id,
    });

    const artifact = await makeArtifactFile({
      sandboxId: sandbox.id,
      path: "/home/sandbox/output/chart.png",
      originalName: null,
      mimeType: "image/png",
      data: Buffer.from([1, 2, 3, 4]),
    });

    await runBackfill();

    const [file] = await db
      .select()
      .from(schema.filesTable)
      .where(eq(schema.filesTable.id, artifact.id));
    expect(file).toBeDefined();
    expect(file.filename).toBe("chart.png");
  });

  test("derives filename from the path basename when original_name is empty", async ({
    makeUser,
    makeOrganization,
    makeAgent,
    makeConversation,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });
    const conversation = await makeConversation(agent.id, {
      organizationId: org.id,
      userId: user.id,
    });
    const sandbox = await makeSandbox({
      organizationId: org.id,
      userId: user.id,
      conversationId: conversation.id,
    });

    const artifact = await makeArtifactFile({
      sandboxId: sandbox.id,
      path: "/home/sandbox/out/report.csv",
      originalName: "",
      mimeType: "text/csv",
      data: Buffer.from("report contents"),
    });

    await runBackfill();

    const [file] = await db
      .select()
      .from(schema.filesTable)
      .where(eq(schema.filesTable.id, artifact.id));
    expect(file).toBeDefined();
    // NULLIF(original_name, '') falls through to the path basename, not ''.
    expect(file.filename).toBe("report.csv");
  });

  test("is idempotent: re-running does not duplicate or resurrect rows", async ({
    makeUser,
    makeOrganization,
    makeAgent,
    makeConversation,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });
    const conversation = await makeConversation(agent.id, {
      organizationId: org.id,
      userId: user.id,
    });
    const sandbox = await makeSandbox({
      organizationId: org.id,
      userId: user.id,
      conversationId: conversation.id,
    });

    const data = Buffer.from("report contents");
    const artifact = await makeArtifactFile({
      sandboxId: sandbox.id,
      path: "/home/sandbox/output/report.csv",
      originalName: "report.csv",
      mimeType: "text/csv",
      data,
    });

    // Run the backfill twice; the second pass exercises ON CONFLICT DO NOTHING.
    await runBackfill();
    await runBackfill();

    // Exactly one files row for the id — no duplicate from the second pass.
    const files = await db
      .select()
      .from(schema.filesTable)
      .where(eq(schema.filesTable.id, artifact.id));
    expect(files).toHaveLength(1);
    const file = files[0];
    // Fields remain intact (the conflicting re-insert was skipped, not applied).
    expect(file.id).toBe(artifact.id);
    expect(file.filename).toBe("report.csv");
    expect(file.mimeType).toBe("text/csv");
    expect(file.sizeBytes).toBe(data.byteLength);
    expect(Buffer.from(file.data as Buffer).toString()).toBe("report contents");
    expect(file.organizationId).toBe(org.id);
    expect(file.userId).toBe(user.id);
    expect(file.conversationId).toBe(conversation.id);
    expect(file.sandboxId).toBe(sandbox.id);

    // The source artifact stays deleted; the re-run does not resurrect it.
    const remaining = await db
      .select()
      .from(schema.skillSandboxFilesTable)
      .where(eq(schema.skillSandboxFilesTable.id, artifact.id));
    expect(remaining).toHaveLength(0);
  });

  test("leaves kind='upload' rows untouched", async ({
    makeUser,
    makeOrganization,
    makeAgent,
    makeConversation,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });
    const conversation = await makeConversation(agent.id, {
      organizationId: org.id,
      userId: user.id,
    });
    const sandbox = await makeSandbox({
      organizationId: org.id,
      userId: user.id,
      conversationId: conversation.id,
    });

    const [upload] = await db
      .insert(schema.skillSandboxFilesTable)
      .values({
        kind: "upload",
        sandboxId: sandbox.id,
        path: "/home/sandbox/attachments/input.txt",
        mimeType: "text/plain",
        originalName: "input.txt",
        sizeBytes: 5,
        data: Buffer.from("hello"),
      })
      .returning();

    await runBackfill();

    const files = await db
      .select()
      .from(schema.filesTable)
      .where(eq(schema.filesTable.id, upload.id));
    expect(files).toHaveLength(0);

    const remaining = await db
      .select()
      .from(schema.skillSandboxFilesTable)
      .where(eq(schema.skillSandboxFilesTable.id, upload.id));
    expect(remaining).toHaveLength(1);
  });
});
