import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import FileModel from "./file";

const PNG = Buffer.from("not-really-png");

async function seedFile(params: {
  organizationId: string;
  userId: string;
  folderId?: string | null;
  conversationId?: string | null;
  filename?: string;
}) {
  return FileModel.create({
    organizationId: params.organizationId,
    userId: params.userId,
    conversationId: params.conversationId ?? null,
    folderId: params.folderId ?? null,
    folderName: null,
    namespace: { kind: "user", userId: params.userId },
    filename: params.filename ?? "out.png",
    mimeType: "image/png",
    sizeBytes: PNG.byteLength,
    data: PNG,
  });
}

describe("FileModel", () => {
  test("create + findById round-trips bytes and metadata", async ({
    makeOrganization,
    makeUser,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const created = await seedFile({
      organizationId: org.id,
      userId: user.id,
    });
    const found = await FileModel.findById(created.id);
    expect(found).not.toBeNull();
    expect(found?.filename).toBe("out.png");
    expect(found?.userId).toBe(user.id);
    expect(Buffer.from(found?.data ?? []).equals(PNG)).toBe(true);
  });

  test("listForUser shows the user's own files (root + personal folders), and excludes project-folder files", async ({
    makeOrganization,
    makeUser,
  }) => {
    const author = await makeUser();
    const stranger = await makeUser();
    const org = await makeOrganization();

    // a personal folder owned by the author …
    const [personal] = await db
      .insert(schema.foldersTable)
      .values({ organizationId: org.id, userId: author.id, name: "notes" })
      .returning();
    // … a project folder (no user owner) …
    const [project] = await db
      .insert(schema.projectsTable)
      .values({ organizationId: org.id, userId: author.id, name: "proj" })
      .returning();
    const [projectFolder] = await db
      .insert(schema.foldersTable)
      .values({ organizationId: org.id, projectId: project.id, name: "proj" })
      .returning();

    await seedFile({
      organizationId: org.id,
      userId: author.id,
      filename: "root.png",
    });
    await seedFile({
      organizationId: org.id,
      userId: author.id,
      folderId: personal.id,
      filename: "in-personal.png",
    });
    // a file the author produced into a project folder — surfaces via the
    // project listing, NOT here.
    await seedFile({
      organizationId: org.id,
      userId: author.id,
      folderId: projectFolder.id,
      filename: "in-project.png",
    });

    const authorRows = await FileModel.listForUser({
      organizationId: org.id,
      userId: author.id,
    });
    expect(authorRows.map((r) => r.filename).sort()).toEqual([
      "in-personal.png",
      "root.png",
    ]);

    const strangerRows = await FileModel.listForUser({
      organizationId: org.id,
      userId: stranger.id,
    });
    expect(strangerRows).toHaveLength(0);
  });

  test("listByConversation keeps the author view", async ({
    makeOrganization,
    makeUser,
    makeAgent,
    makeConversation,
  }) => {
    const user = await makeUser();
    const other = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent();
    const conversation = await makeConversation(agent.id, {
      organizationId: org.id,
      userId: user.id,
    });

    await seedFile({
      organizationId: org.id,
      userId: user.id,
      conversationId: conversation.id,
      filename: "mine.png",
    });
    await seedFile({
      organizationId: org.id,
      userId: other.id,
      conversationId: conversation.id,
      filename: "theirs.png",
    });

    const rows = await FileModel.listByConversation({
      organizationId: org.id,
      userId: user.id,
      conversationId: conversation.id,
    });
    expect(rows.map((r) => r.filename)).toEqual(["mine.png"]);
  });

  test("deleteById removes the row", async ({ makeOrganization, makeUser }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const created = await seedFile({
      organizationId: org.id,
      userId: user.id,
    });
    await FileModel.deleteById(created.id);
    expect(await FileModel.findById(created.id)).toBeNull();
  });
});
