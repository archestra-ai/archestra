import ConversationAttachmentModel from "@/models/conversation-attachment";
import { expect, test } from "@/test";
import type { ChatMessage } from "@/types";
import { __test, __testEstimateChatMessagesTokens } from "./context-compaction";

const refUrl = (id: string) => `/api/chat/attachments/${id}/content`;

test("token-estimate sync branch uses part.fileSize for ref'd PDFs", () => {
  const refMessage: ChatMessage = {
    role: "user",
    parts: [
      { type: "text", text: "look at this" },
      {
        type: "file",
        url: refUrl("11111111-1111-4111-9111-111111111111"),
        mediaType: "application/pdf",
        filename: "big.pdf",
        fileSize: 5 * 1024 * 1024,
      },
    ],
  };

  const refEstimate = __testEstimateChatMessagesTokens({
    provider: "anthropic",
    messages: [refMessage],
  });

  // 5MB PDF / 12 bytes-per-token ≈ ~436k tokens. The estimator adds some
  // header overhead, but the bulk is the file-size derived count.
  expect(refEstimate).toBeGreaterThan(400_000);
});

test("token-estimate ref branch without fileSize degrades to header-only", () => {
  const refMessage: ChatMessage = {
    role: "user",
    parts: [
      {
        type: "file",
        url: refUrl("22222222-2222-4222-9222-222222222222"),
        mediaType: "application/pdf",
        filename: "no-size.pdf",
        // intentionally missing fileSize
      },
    ],
  };

  const estimate = __testEstimateChatMessagesTokens({
    provider: "anthropic",
    messages: [refMessage],
  });

  // No fileSize -> no per-byte token contribution. Just header text in the
  // message text; should fall well under the with-fileSize case.
  expect(estimate).toBeLessThan(1000);
});

test("token-estimate ref branch and data: URL branch produce comparable estimates", () => {
  // Sanity check the dual paths agree within tolerance for similarly-sized
  // content, so swapping to refs doesn't change compaction-trigger behavior.
  const bytes = Buffer.from("x".repeat(64_000), "utf8");
  const dataMessage: ChatMessage = {
    role: "user",
    parts: [
      {
        type: "file",
        url: `data:application/pdf;base64,${bytes.toString("base64")}`,
        mediaType: "application/pdf",
        filename: "data.pdf",
      },
    ],
  };
  const refMessage: ChatMessage = {
    role: "user",
    parts: [
      {
        type: "file",
        url: refUrl("33333333-3333-4333-9333-333333333333"),
        mediaType: "application/pdf",
        filename: "ref.pdf",
        fileSize: bytes.byteLength,
      },
    ],
  };

  const dataEstimate = __testEstimateChatMessagesTokens({
    provider: "anthropic",
    messages: [dataMessage],
  });
  const refEstimate = __testEstimateChatMessagesTokens({
    provider: "anthropic",
    messages: [refMessage],
  });

  // Both routes feed byte size through the same PDF_BYTES_PER_TOKEN_ESTIMATE
  // and emit the same `[binary file payload: N bytes]` placeholder text, so
  // the estimates agree. This is a feature — swapping inline-data-URLs for
  // refs does not perturb the compaction-trigger threshold.
  expect(dataEstimate).toBe(refEstimate);
  expect(refEstimate).toBeGreaterThan(bytes.byteLength / 12 - 50);
});

test("summary path includes text_preview for a ref attachment in the same conversation", async ({
  makeAgent,
  makeConversation,
}) => {
  const agent = await makeAgent();
  const conversation = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });
  const bytes = Buffer.from("placeholder", "utf8");
  const row = await ConversationAttachmentModel.create({
    organizationId: conversation.organizationId,
    conversationId: conversation.id,
    uploadedByUserId: conversation.userId,
    originalName: "doc.pdf",
    mimeType: "application/pdf",
    fileSize: bytes.byteLength,
    contentHash: ConversationAttachmentModel.computeContentHash(bytes),
    fileData: bytes,
  });
  await ConversationAttachmentModel.updateTextPreview(
    row.id,
    "ok",
    "MARKER_PREVIEW_TEXT for the compaction summarizer",
  );

  const messages: ChatMessage[] = [
    {
      role: "user",
      parts: [
        { type: "text", text: "What does the doc say?" },
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

  const prompt = await __test.buildCompactionPrompt({
    previousSummary: null,
    messages,
    conversationId: conversation.id,
  });

  expect(prompt).toContain("MARKER_PREVIEW_TEXT");
});

test("summary path silently drops refs from a DIFFERENT conversation (ACL)", async ({
  makeAgent,
  makeConversation,
}) => {
  const agent = await makeAgent();
  const otherConvo = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });
  const requestConvo = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });
  const bytes = Buffer.from("secret", "utf8");
  const row = await ConversationAttachmentModel.create({
    organizationId: otherConvo.organizationId,
    conversationId: otherConvo.id,
    uploadedByUserId: otherConvo.userId,
    originalName: "secret.pdf",
    mimeType: "application/pdf",
    fileSize: bytes.byteLength,
    contentHash: ConversationAttachmentModel.computeContentHash(bytes),
    fileData: bytes,
  });
  await ConversationAttachmentModel.updateTextPreview(
    row.id,
    "ok",
    "SECRET_PREVIEW_must_not_leak_across_conversations",
  );

  const messages: ChatMessage[] = [
    {
      role: "user",
      parts: [
        { type: "text", text: "load the other conv's file" },
        {
          type: "file",
          url: refUrl(row.id),
          mediaType: "application/pdf",
          filename: "secret.pdf",
          fileSize: bytes.byteLength,
        },
      ],
    },
  ];

  const prompt = await __test.buildCompactionPrompt({
    previousSummary: null,
    messages,
    conversationId: requestConvo.id,
  });

  expect(prompt).not.toContain("SECRET_PREVIEW");
  expect(prompt).toContain(
    "File contents were not available to the compaction summarizer",
  );
});

test("summary path falls back when ref's preview status is 'failed'", async ({
  makeAgent,
  makeConversation,
}) => {
  const agent = await makeAgent();
  const conversation = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });
  const bytes = Buffer.from("placeholder", "utf8");
  const row = await ConversationAttachmentModel.create({
    organizationId: conversation.organizationId,
    conversationId: conversation.id,
    uploadedByUserId: conversation.userId,
    originalName: "broken.pdf",
    mimeType: "application/pdf",
    fileSize: bytes.byteLength,
    contentHash: ConversationAttachmentModel.computeContentHash(bytes),
    fileData: bytes,
  });
  await ConversationAttachmentModel.updateTextPreview(row.id, "failed", null);

  const messages: ChatMessage[] = [
    {
      role: "user",
      parts: [
        {
          type: "file",
          url: refUrl(row.id),
          mediaType: "application/pdf",
          filename: "broken.pdf",
          fileSize: bytes.byteLength,
        },
      ],
    },
  ];

  const prompt = await __test.buildCompactionPrompt({
    previousSummary: null,
    messages,
    conversationId: conversation.id,
  });

  expect(prompt).toContain(
    "File contents were not available to the compaction summarizer",
  );
});

test("backward-compat: data: URL summary path still decodes text PDFs", async ({
  makeAgent,
  makeConversation,
}) => {
  const agent = await makeAgent();
  const conversation = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });
  const bytes = Buffer.from("LEGACY_TEXT_FOR_COMPACTION", "utf8");
  const dataUrl = `data:text/plain;base64,${bytes.toString("base64")}`;
  const messages: ChatMessage[] = [
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

  const prompt = await __test.buildCompactionPrompt({
    previousSummary: null,
    messages,
    conversationId: conversation.id,
  });

  expect(prompt).toContain("LEGACY_TEXT_FOR_COMPACTION");
});
