import ConversationAttachmentModel from "@/models/conversation-attachment";
import { expect, test } from "@/test";
import type { ChatMessage } from "@/types";
import { materializeAttachments } from "./materialize-attachments";

function expectPresent<T>(value: T | null | undefined): T {
  expect(value).toBeDefined();
  if (value == null) {
    throw new Error("Expected value to be present");
  }
  return value;
}

test("rehydrates ref to inline data: URL and adds Anthropic cache_control", async ({
  makeAgent,
  makeConversation,
}) => {
  const agent = await makeAgent();
  const conversation = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });
  const bytes = Buffer.from("payload bytes", "utf8");
  const row = await ConversationAttachmentModel.create({
    organizationId: conversation.organizationId,
    conversationId: conversation.id,
    uploadedByUserId: conversation.userId,
    originalName: "doc.txt",
    mimeType: "text/plain",
    fileSize: bytes.byteLength,
    contentHash: ConversationAttachmentModel.computeContentHash(bytes),
    fileData: bytes,
  });

  const inputMessages: ChatMessage[] = [
    {
      role: "user",
      parts: [
        { type: "text", text: "hi" },
        {
          type: "file",
          url: `/api/chat/attachments/${row.id}/content`,
          mediaType: "text/plain",
          filename: "doc.txt",
          fileSize: bytes.byteLength,
        },
      ],
    },
  ];

  const output = await materializeAttachments(inputMessages, conversation.id);

  const filePart = expectPresent(output[0].parts?.[1]);
  expect(filePart.type).toBe("file");
  expect(filePart.url).toBe(
    `data:text/plain;base64,${bytes.toString("base64")}`,
  );
  expect(filePart.mediaType).toBe("text/plain");
  expect(filePart.filename).toBe("doc.txt");
  expect(filePart.providerMetadata).toMatchObject({
    anthropic: { cacheControl: { type: "ephemeral" } },
  });

  // Input is not mutated.
  expect(expectPresent(inputMessages[0].parts?.[1]).url).toBe(
    `/api/chat/attachments/${row.id}/content`,
  );
});

test("legacy inline data: URL file parts keep the url but get Anthropic cache_control", async () => {
  const dataUrl = `data:application/pdf;base64,${Buffer.from("legacy", "utf8").toString("base64")}`;
  const input: ChatMessage[] = [
    {
      role: "user",
      parts: [
        {
          type: "file",
          url: dataUrl,
          mediaType: "application/pdf",
          filename: "legacy.pdf",
        },
      ],
    },
  ];

  const output = await materializeAttachments(
    input,
    "00000000-0000-4000-8000-000000000000",
  );
  const filePart = expectPresent(output[0].parts?.[0]);
  // URL is preserved verbatim — we don't rewrite or re-encode the bytes.
  expect(filePart.url).toBe(dataUrl);
  // But cache_control IS applied, so Anthropic prompt-caches across turns.
  // Without this, same-tab follow-ups (FE stamps persistedMessageId but
  // keeps the original data: URL in state) would re-bill the full file at
  // input price on every turn.
  expect(filePart.providerMetadata).toMatchObject({
    anthropic: { cacheControl: { type: "ephemeral" } },
  });
});

test("preserves existing providerMetadata on data: URL file parts when adding cache_control", async () => {
  const dataUrl = `data:application/pdf;base64,${Buffer.from("x", "utf8").toString("base64")}`;
  const input: ChatMessage[] = [
    {
      role: "user",
      parts: [
        {
          type: "file",
          url: dataUrl,
          mediaType: "application/pdf",
          filename: "with-meta.pdf",
          providerMetadata: { openai: { detail: "high" } },
        },
      ],
    },
  ];
  const output = await materializeAttachments(
    input,
    "00000000-0000-4000-8000-000000000000",
  );
  const filePart = expectPresent(output[0].parts?.[0]);
  expect(filePart.providerMetadata).toMatchObject({
    openai: { detail: "high" },
    anthropic: { cacheControl: { type: "ephemeral" } },
  });
});

test("missing or malformed refs do not crash and leave the part as-is", async () => {
  const messages: ChatMessage[] = [
    {
      role: "user",
      parts: [
        {
          type: "file",
          url: "/api/chat/attachments/00000000-0000-4000-8000-000000000000/content",
          mediaType: "text/plain",
          filename: "ghost.txt",
        },
      ],
    },
  ];

  const output = await materializeAttachments(
    messages,
    "00000000-0000-4000-8000-000000000000",
  );
  expect(expectPresent(output[0].parts?.[0]).url).toBe(
    "/api/chat/attachments/00000000-0000-4000-8000-000000000000/content",
  );
});

test("refs scoped to a DIFFERENT conversation are silently ignored", async ({
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
  const bytes = Buffer.from("cross-convo secret", "utf8");
  const row = await ConversationAttachmentModel.create({
    organizationId: otherConvo.organizationId,
    conversationId: otherConvo.id,
    uploadedByUserId: otherConvo.userId,
    originalName: "secret.txt",
    mimeType: "text/plain",
    fileSize: bytes.byteLength,
    contentHash: ConversationAttachmentModel.computeContentHash(bytes),
    fileData: bytes,
  });

  const input: ChatMessage[] = [
    {
      role: "user",
      parts: [
        {
          type: "file",
          url: `/api/chat/attachments/${row.id}/content`,
          mediaType: "text/plain",
          filename: "secret.txt",
        },
      ],
    },
  ];

  // Request claims to be in requestConvo but references otherConvo's attachment.
  const output = await materializeAttachments(input, requestConvo.id);
  // Ref URL stays as-is — the bytes did NOT leak into the LLM call payload.
  const outputPart = expectPresent(output[0].parts?.[0]);
  expect(outputPart.url).toBe(`/api/chat/attachments/${row.id}/content`);
  expect(outputPart.providerMetadata).toBeUndefined();
});

test("batch-loads multiple refs in a single message", async ({
  makeAgent,
  makeConversation,
}) => {
  const agent = await makeAgent();
  const conversation = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });

  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const bytes = Buffer.from(`f${i}`, "utf8");
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

  const input: ChatMessage[] = [
    {
      role: "user",
      parts: ids.map((id, i) => ({
        type: "file",
        url: `/api/chat/attachments/${id}/content`,
        mediaType: "text/plain",
        filename: `f${i}.txt`,
      })),
    },
  ];

  const output = await materializeAttachments(input, conversation.id);
  for (let i = 0; i < ids.length; i++) {
    expect(expectPresent(output[0].parts?.[i]).url).toBe(
      `data:text/plain;base64,${Buffer.from(`f${i}`, "utf8").toString("base64")}`,
    );
  }
});

test("no refs in messages returns a clone without DB hits", async () => {
  const messages: ChatMessage[] = [
    { role: "user", parts: [{ type: "text", text: "hello" }] },
    { role: "assistant", parts: [{ type: "text", text: "hi" }] },
  ];

  const output = await materializeAttachments(
    messages,
    "00000000-0000-4000-8000-000000000000",
  );
  expect(output).toEqual(messages);
  // Confirm deep copy: mutating output does not affect input
  expectPresent(output[0].parts?.[0]).text = "mutated";
  expect(expectPresent(messages[0].parts?.[0]).text).toBe("hello");
});
