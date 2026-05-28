import ConversationAttachmentModel from "@/models/conversation-attachment";
import { expect, test } from "@/test";
import type { ChatMessage } from "@/types";
import { cloneAttachmentsForFork } from "./clone-attachments-for-fork";

const refUrl = (id: string) => `/api/chat/attachments/${id}/content`;

test("clones the underlying row and rewrites refs to the new id", async ({
  makeAgent,
  makeConversation,
}) => {
  const agent = await makeAgent();
  const source = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });
  const fork = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });
  const bytes = Buffer.from("forkable-bytes", "utf8");
  const row = await ConversationAttachmentModel.create({
    organizationId: source.organizationId,
    conversationId: source.id,
    uploadedByUserId: source.userId,
    originalName: "doc.pdf",
    mimeType: "application/pdf",
    fileSize: bytes.byteLength,
    contentHash: ConversationAttachmentModel.computeContentHash(bytes),
    fileData: bytes,
  });
  await ConversationAttachmentModel.updateTextPreview(
    row.id,
    "ok",
    "FORK_PREVIEW",
  );

  const sourceMessages: ChatMessage[] = [
    {
      role: "user",
      parts: [
        { type: "text", text: "look at this" },
        {
          type: "file",
          url: refUrl(row.id),
          mediaType: "application/pdf",
          filename: "doc.pdf",
          fileSize: bytes.byteLength,
        },
      ],
    },
  ];

  const forked = await cloneAttachmentsForFork({
    sourceMessages,
    sourceConversationId: source.id,
    newConversationId: fork.id,
    newOrganizationId: fork.organizationId,
    newUploadedByUserId: fork.userId,
  });

  // The ref URL was rewritten to a NEW id, not the source id.
  const forkedPart = forked[0].parts![1];
  expect(forkedPart.type).toBe("file");
  expect(forkedPart.url).not.toBe(refUrl(row.id));
  expect(forkedPart.url).toMatch(
    /^\/api\/chat\/attachments\/[0-9a-f-]+\/content$/,
  );

  // The new row exists scoped to the fork's conversationId and carries
  // identical bytes, hash, mime, and preview.
  const parsed = (forkedPart.url as string).match(
    /\/api\/chat\/attachments\/([^/]+)\/content/,
  );
  const newId = parsed![1];
  const clonedRow = await ConversationAttachmentModel.findByIdWithData(newId);
  expect(clonedRow).not.toBeNull();
  expect(clonedRow!.conversationId).toBe(fork.id);
  expect(clonedRow!.organizationId).toBe(fork.organizationId);
  expect(clonedRow!.uploadedByUserId).toBe(fork.userId);
  expect(clonedRow!.contentHash).toBe(row.contentHash);
  expect(clonedRow!.fileSize).toBe(row.fileSize);
  expect(clonedRow!.fileData.equals(bytes)).toBe(true);
  expect(clonedRow!.textPreview).toBe("FORK_PREVIEW");
  expect(clonedRow!.textPreviewStatus).toBe("ok");

  // Source row stays untouched — fork is a copy, not a move.
  const sourceRow = await ConversationAttachmentModel.findByIdWithData(row.id);
  expect(sourceRow).not.toBeNull();
  expect(sourceRow!.conversationId).toBe(source.id);

  // Input array is not mutated.
  expect(sourceMessages[0].parts![1].url).toBe(refUrl(row.id));
});

test("deduplicates identical refs into a single clone", async ({
  makeAgent,
  makeConversation,
}) => {
  const agent = await makeAgent();
  const source = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });
  const fork = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });
  const bytes = Buffer.from("once", "utf8");
  const row = await ConversationAttachmentModel.create({
    organizationId: source.organizationId,
    conversationId: source.id,
    uploadedByUserId: source.userId,
    originalName: "once.txt",
    mimeType: "text/plain",
    fileSize: bytes.byteLength,
    contentHash: ConversationAttachmentModel.computeContentHash(bytes),
    fileData: bytes,
  });

  // Same ref appears across two messages.
  const sourceMessages: ChatMessage[] = [
    {
      role: "user",
      parts: [
        {
          type: "file",
          url: refUrl(row.id),
          mediaType: "text/plain",
          filename: "once.txt",
        },
      ],
    },
    {
      role: "assistant",
      parts: [
        { type: "text", text: "ok" },
        {
          type: "file",
          url: refUrl(row.id),
          mediaType: "text/plain",
          filename: "once.txt",
        },
      ],
    },
  ];

  const forked = await cloneAttachmentsForFork({
    sourceMessages,
    sourceConversationId: source.id,
    newConversationId: fork.id,
    newOrganizationId: fork.organizationId,
    newUploadedByUserId: fork.userId,
  });

  const urlA = forked[0].parts![0].url as string;
  const urlB = forked[1].parts![1].url as string;
  // Both refs in the fork point at the SAME new id (one clone, not two).
  expect(urlA).toBe(urlB);
  expect(urlA).not.toBe(refUrl(row.id));
});

test("no refs: returns the input unchanged (no DB writes)", async ({
  makeAgent,
  makeConversation,
}) => {
  const agent = await makeAgent();
  const fork = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });

  const sourceMessages: ChatMessage[] = [
    { role: "user", parts: [{ type: "text", text: "hi" }] },
    { role: "assistant", parts: [{ type: "text", text: "hi" }] },
  ];

  const forked = await cloneAttachmentsForFork({
    sourceMessages,
    sourceConversationId: "00000000-0000-4000-8000-000000000000",
    newConversationId: fork.id,
    newOrganizationId: fork.organizationId,
    newUploadedByUserId: fork.userId,
  });

  expect(forked).toBe(sourceMessages);
});

test("legacy inline data: URLs are passed through untouched", async ({
  makeAgent,
  makeConversation,
}) => {
  const agent = await makeAgent();
  const fork = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });
  const dataUrl = `data:text/plain;base64,${Buffer.from("legacy", "utf8").toString("base64")}`;
  const sourceMessages: ChatMessage[] = [
    {
      role: "user",
      parts: [
        {
          type: "file",
          url: dataUrl,
          mediaType: "text/plain",
          filename: "legacy.txt",
        },
      ],
    },
  ];

  const forked = await cloneAttachmentsForFork({
    sourceMessages,
    sourceConversationId: "00000000-0000-4000-8000-000000000000",
    newConversationId: fork.id,
    newOrganizationId: fork.organizationId,
    newUploadedByUserId: fork.userId,
  });

  // Data URL pass-through — fork still works for pre-v1 conversations.
  expect(forked[0].parts![0].url).toBe(dataUrl);
});

test("refuses to clone a row whose conversationId is NOT the source (IDOR guard)", async ({
  makeAgent,
  makeConversation,
}) => {
  const agent = await makeAgent();
  // The "source" conversation the attacker has read access to.
  const source = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });
  // A foreign conversation in the same org with a secret attachment.
  const foreign = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });
  const fork = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });
  const secretBytes = Buffer.from("FOREIGN_SECRET_BYTES", "utf8");
  const foreignRow = await ConversationAttachmentModel.create({
    organizationId: foreign.organizationId,
    conversationId: foreign.id,
    uploadedByUserId: foreign.userId,
    originalName: "secret.bin",
    mimeType: "application/octet-stream",
    fileSize: secretBytes.byteLength,
    contentHash: ConversationAttachmentModel.computeContentHash(secretBytes),
    fileData: secretBytes,
  });

  // Attacker crafts a ref to the foreign row inside their OWN source convo.
  // extractInlineAttachments only rewrites data: URLs, so a crafted
  // /api/chat/attachments/<foreign-id>/content url would persist verbatim
  // into messages.content in production.
  const sourceMessages: ChatMessage[] = [
    {
      role: "user",
      parts: [
        {
          type: "file",
          url: refUrl(foreignRow.id),
          mediaType: "application/octet-stream",
          filename: "crafted.bin",
        },
      ],
    },
  ];

  const forked = await cloneAttachmentsForFork({
    sourceMessages,
    sourceConversationId: source.id,
    newConversationId: fork.id,
    newOrganizationId: fork.organizationId,
    newUploadedByUserId: fork.userId,
  });

  // The crafted ref does NOT get cloned — its url is left untouched in the fork.
  expect(forked[0].parts![0].url).toBe(refUrl(foreignRow.id));

  // No new row was created in the fork pointing at the foreign bytes.
  const forkRows =
    await ConversationAttachmentModel.findByConversationIdWithoutData(fork.id);
  expect(forkRows.length).toBe(0);

  // The foreign row is untouched.
  const stillForeign = await ConversationAttachmentModel.findByIdWithData(
    foreignRow.id,
  );
  expect(stillForeign!.conversationId).toBe(foreign.id);
});
