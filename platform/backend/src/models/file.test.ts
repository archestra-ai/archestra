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
    namespaceUserId: params.userId,
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

  test("listForUser shows the author face and the folder-owner face, nothing else", async ({
    makeOrganization,
    makeUser,
  }) => {
    const folderOwner = await makeUser();
    const author = await makeUser();
    const stranger = await makeUser();
    const org = await makeOrganization();

    // a result folder owned by folderOwner (project-chat shape) …
    const [folder] = await db
      .insert(schema.skillSandboxFoldersTable)
      .values({
        organizationId: org.id,
        userId: folderOwner.id,
        name: "results",
      })
      .returning();
    // … into which another member authored a file
    await seedFile({
      organizationId: org.id,
      userId: author.id,
      folderId: folder.id,
      filename: "shared.png",
    });

    const ownerRows = await FileModel.listForUser({
      organizationId: org.id,
      userId: folderOwner.id,
    });
    expect(ownerRows.map((r) => r.filename)).toContain("shared.png");

    const authorRows = await FileModel.listForUser({
      organizationId: org.id,
      userId: author.id,
    });
    expect(authorRows.map((r) => r.filename)).toContain("shared.png");

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
