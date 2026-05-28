import ConversationAttachmentModel from "@/models/conversation-attachment";
import { expect, test } from "@/test";

function expectPresent<T>(value: T | null | undefined): T {
  expect(value).toBeDefined();
  if (value == null) {
    throw new Error("Expected value to be present");
  }
  return value;
}

test("create + findByIdWithData round-trips bytes and metadata", async ({
  makeAgent,
  makeConversation,
}) => {
  const agent = await makeAgent();
  const conversation = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });
  const bytes = Buffer.from("hello world", "utf8");

  const created = await ConversationAttachmentModel.create({
    organizationId: conversation.organizationId,
    conversationId: conversation.id,
    uploadedByUserId: conversation.userId,
    originalName: "hello.txt",
    mimeType: "text/plain",
    fileSize: bytes.byteLength,
    contentHash: ConversationAttachmentModel.computeContentHash(bytes),
    fileData: bytes,
    textPreviewStatus: "pending",
  });

  expect(created.id).toBeDefined();
  expect(created.fileSize).toBe(bytes.byteLength);

  const fetched = await ConversationAttachmentModel.findByIdWithData(
    created.id,
  );
  const fetchedRow = expectPresent(fetched);
  expect(fetchedRow.fileData.equals(bytes)).toBe(true);
  expect(fetchedRow.originalName).toBe("hello.txt");
  expect(fetchedRow.mimeType).toBe("text/plain");
});

test("findById omits fileData (metadata-only)", async ({
  makeAgent,
  makeConversation,
}) => {
  const agent = await makeAgent();
  const conversation = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });
  const bytes = Buffer.from("x".repeat(1024), "utf8");

  const created = await ConversationAttachmentModel.create({
    organizationId: conversation.organizationId,
    conversationId: conversation.id,
    uploadedByUserId: conversation.userId,
    originalName: "blob.bin",
    mimeType: "application/octet-stream",
    fileSize: bytes.byteLength,
    contentHash: ConversationAttachmentModel.computeContentHash(bytes),
    fileData: bytes,
  });

  const meta = await ConversationAttachmentModel.findById(created.id);
  const metadata = expectPresent(meta);
  expect((meta as unknown as { fileData?: unknown }).fileData).toBeUndefined();
  expect(metadata.fileSize).toBe(bytes.byteLength);
});

test("findByIdsWithData batch-loads multiple rows", async ({
  makeAgent,
  makeConversation,
}) => {
  const agent = await makeAgent();
  const conversation = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });

  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const bytes = Buffer.from(`file-${i}`, "utf8");
    const row = await ConversationAttachmentModel.create({
      organizationId: conversation.organizationId,
      conversationId: conversation.id,
      uploadedByUserId: conversation.userId,
      originalName: `f${i}.txt`,
      mimeType: "text/plain",
      fileSize: bytes.byteLength,
      contentHash: ConversationAttachmentModel.computeContentHash(bytes),
      fileData: bytes,
    });
    ids.push(row.id);
  }

  const rows = await ConversationAttachmentModel.findByIdsWithData(ids);
  expect(rows).toHaveLength(3);
  for (const row of rows) {
    expect(row.fileData.toString("utf8")).toMatch(/^file-\d$/);
  }
});

test("findByIdsWithData with empty array returns empty array", async () => {
  const rows = await ConversationAttachmentModel.findByIdsWithData([]);
  expect(rows).toEqual([]);
});

test("softDelete hides the row from findById / findByIdWithData", async ({
  makeAgent,
  makeConversation,
}) => {
  const agent = await makeAgent();
  const conversation = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });
  const bytes = Buffer.from("doomed", "utf8");

  const row = await ConversationAttachmentModel.create({
    organizationId: conversation.organizationId,
    conversationId: conversation.id,
    uploadedByUserId: conversation.userId,
    originalName: "x.txt",
    mimeType: "text/plain",
    fileSize: bytes.byteLength,
    contentHash: ConversationAttachmentModel.computeContentHash(bytes),
    fileData: bytes,
  });

  await ConversationAttachmentModel.softDelete(row.id);

  expect(await ConversationAttachmentModel.findById(row.id)).toBeNull();
  expect(await ConversationAttachmentModel.findByIdWithData(row.id)).toBeNull();
});

test("unique (conversation_id, content_hash) partial index blocks duplicate live rows but tolerates soft-deleted history", async ({
  makeAgent,
  makeConversation,
}) => {
  const agent = await makeAgent();
  const conversation = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });
  const bytes = Buffer.from("dedup-race-bytes", "utf8");
  const contentHash = ConversationAttachmentModel.computeContentHash(bytes);
  const baseRow = {
    organizationId: conversation.organizationId,
    conversationId: conversation.id,
    uploadedByUserId: conversation.userId,
    originalName: "race.bin",
    mimeType: "application/octet-stream",
    fileSize: bytes.byteLength,
    contentHash,
    fileData: bytes,
  };

  const first = await ConversationAttachmentModel.create(baseRow);

  // Second concurrent live insert with the same (conv_id, content_hash) is
  // rejected by the partial unique index — closes the find→create race.
  await expect(ConversationAttachmentModel.create(baseRow)).rejects.toThrow();

  // After soft-delete, re-inserting the same bytes succeeds (partial index
  // only enforces uniqueness over live rows, so history doesn't conflict).
  await ConversationAttachmentModel.softDelete(first.id);
  const third = await ConversationAttachmentModel.create(baseRow);
  expect(third.id).not.toBe(first.id);
  expect(third.contentHash).toBe(contentHash);
});

test("computeContentHash is deterministic and content-sensitive", () => {
  const a = ConversationAttachmentModel.computeContentHash(
    Buffer.from("same", "utf8"),
  );
  const b = ConversationAttachmentModel.computeContentHash(
    Buffer.from("same", "utf8"),
  );
  const c = ConversationAttachmentModel.computeContentHash(
    Buffer.from("different", "utf8"),
  );
  expect(a).toEqual(b);
  expect(a).not.toEqual(c);
});

test("updateTextPreview sets status and text", async ({
  makeAgent,
  makeConversation,
}) => {
  const agent = await makeAgent();
  const conversation = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });
  const bytes = Buffer.from("pdf-mock", "utf8");

  const row = await ConversationAttachmentModel.create({
    organizationId: conversation.organizationId,
    conversationId: conversation.id,
    uploadedByUserId: conversation.userId,
    originalName: "doc.pdf",
    mimeType: "application/pdf",
    fileSize: bytes.byteLength,
    contentHash: ConversationAttachmentModel.computeContentHash(bytes),
    fileData: bytes,
    textPreviewStatus: "pending",
  });

  await ConversationAttachmentModel.updateTextPreview(
    row.id,
    "ok",
    "extracted text",
  );

  const meta = await ConversationAttachmentModel.findById(row.id);
  expect(meta?.textPreviewStatus).toBe("ok");
  expect(meta?.textPreview).toBe("extracted text");
});
