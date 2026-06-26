import { getModelReadableMimeTypes } from "@archestra/shared";
import config from "@/config";
import ConversationAttachmentModel from "@/models/conversation-attachment";
import { expect, test } from "@/test";
import type { ChatMessage } from "@/types";
import { materializeAttachments } from "./materialize-attachments";

const INGESTIBLE = new Set(["text/plain", "application/pdf", "image/png"]);

test("getModelReadableMimeTypes: null/empty fall back to a readable default; explicit modalities are honored", () => {
  // null/undefined/[] all mean "capabilities unknown" → text+image+pdf default,
  // so common readable types stay inline rather than getting diverted.
  for (const unknown of [null, undefined, []]) {
    const set = getModelReadableMimeTypes(unknown);
    expect(set.has("application/pdf")).toBe(true);
    expect(set.has("image/png")).toBe(true);
    expect(set.has("text/plain")).toBe(true);
    // A genuinely opaque binary is never "readable".
    expect(set.has("application/octet-stream")).toBe(false);
  }

  // A text-only model reads text but not images/pdf → those get referenced.
  const textOnly = getModelReadableMimeTypes(["text"]);
  expect(textOnly.has("text/plain")).toBe(true);
  expect(textOnly.has("image/png")).toBe(false);
  expect(textOnly.has("application/pdf")).toBe(false);
});

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

test("references a non-ingestible attachment in the sandbox instead of inlining it", async ({
  makeAgent,
  makeConversation,
}) => {
  const agent = await makeAgent();
  const conversation = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });
  const bytes = Buffer.from("SQLite header bytes", "utf8");
  const originalName = 'my "orders".sqlite';
  const row = await ConversationAttachmentModel.create({
    organizationId: conversation.organizationId,
    conversationId: conversation.id,
    uploadedByUserId: conversation.userId,
    // A client-controlled name with a quote that must be neutralized.
    originalName,
    mimeType: "application/octet-stream",
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
          mediaType: "application/octet-stream",
          filename: originalName,
        },
      ],
    },
  ];

  const output = await materializeAttachments(
    input,
    conversation.id,
    INGESTIBLE,
  );

  const part = expectPresent(output[0].parts?.[0]);
  expect(part.type).toBe("text");
  // Points at the sandbox attachments dir (not an exact path — staging
  // sanitizes/dedupes the filename) and JSON-encodes the untrusted name.
  expect(part.text).toContain("/home/sandbox/attachments");
  expect(part.text).toContain(JSON.stringify(originalName));
  expect(part.text).toContain("application/octet-stream");
  // The bytes are NOT inlined into the model payload.
  expect(part.text).not.toContain("data:");
  expect(part.url).toBeUndefined();
});

test("keeps an ingestible attachment inlined even when an ingestible set is given", async ({
  makeAgent,
  makeConversation,
}) => {
  const agent = await makeAgent();
  const conversation = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });
  const bytes = Buffer.from("%PDF-1.4 body", "utf8");
  const row = await ConversationAttachmentModel.create({
    organizationId: conversation.organizationId,
    conversationId: conversation.id,
    uploadedByUserId: conversation.userId,
    originalName: "report.pdf",
    mimeType: "application/pdf",
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
          mediaType: "application/pdf",
          filename: "report.pdf",
        },
      ],
    },
  ];

  const output = await materializeAttachments(
    input,
    conversation.id,
    INGESTIBLE,
  );

  const part = expectPresent(output[0].parts?.[0]);
  expect(part.type).toBe("file");
  expect(part.url).toBe(
    `data:application/pdf;base64,${bytes.toString("base64")}`,
  );
});

test("an over-limit non-ingestible attachment is reported as unavailable, not staged or inlined", async ({
  makeAgent,
  makeConversation,
}) => {
  const agent = await makeAgent();
  const conversation = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });
  // Just over the auto-staging limit, so it is never staged into the sandbox.
  const bytes = Buffer.alloc(config.skillsSandbox.artifactBytesLimit + 1);
  const row = await ConversationAttachmentModel.create({
    organizationId: conversation.organizationId,
    conversationId: conversation.id,
    uploadedByUserId: conversation.userId,
    originalName: "huge.bin",
    mimeType: "application/octet-stream",
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
          mediaType: "application/octet-stream",
          filename: "huge.bin",
        },
      ],
    },
  ];

  const output = await materializeAttachments(
    input,
    conversation.id,
    INGESTIBLE,
  );

  const part = expectPresent(output[0].parts?.[0]);
  expect(part.type).toBe("text");
  expect(part.text).toContain("too large");
  // Not staged (no sandbox path), not inlined, and no session-authed URL the
  // sandbox couldn't fetch anyway.
  expect(part.text).not.toContain("/home/sandbox/attachments");
  expect(part.text).not.toContain("/api/chat/attachments");
  expect(part.text).not.toContain("data:");
});

test("inlined text-document also gets a sandbox pointer when the sandbox is enabled", async ({
  makeAgent,
  makeConversation,
}) => {
  const agent = await makeAgent();
  const conversation = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });
  const bytes = Buffer.from("a,b,c\n1,2,3", "utf8");
  const originalName = 'q1 "orders".csv';
  const row = await ConversationAttachmentModel.create({
    organizationId: conversation.organizationId,
    conversationId: conversation.id,
    uploadedByUserId: conversation.userId,
    originalName,
    mimeType: "text/csv",
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
          mediaType: "text/csv",
          filename: originalName,
        },
      ],
    },
  ];

  const prevEnabled = config.skillsSandbox.enabled;
  config.skillsSandbox.enabled = true;
  let output: ChatMessage[];
  try {
    output = await materializeAttachments(input, conversation.id);
  } finally {
    config.skillsSandbox.enabled = prevEnabled;
  }

  // The bytes are still inlined for in-context reading...
  const filePart = expectPresent(output[0].parts?.[0]);
  expect(filePart.type).toBe("file");
  expect(filePart.url).toBe(`data:text/csv;base64,${bytes.toString("base64")}`);
  // ...AND a pointer tells the model the same file is in its sandbox.
  const pointer = expectPresent(output[0].parts?.[1]);
  expect(pointer.type).toBe("text");
  expect(pointer.text).toContain("/home/sandbox/attachments");
  expect(pointer.text).toContain(JSON.stringify(originalName));
  expect(pointer.text).toContain("run_command");
  // Distinct from the "can't be shown inline" replacement wording.
  expect(pointer.text).not.toContain("can't be shown");
  expect(output[0].parts).toHaveLength(2);
});

test("inlined text-document gets NO sandbox pointer when the sandbox is disabled", async ({
  makeAgent,
  makeConversation,
}) => {
  const agent = await makeAgent();
  const conversation = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });
  const bytes = Buffer.from("a,b,c", "utf8");
  const row = await ConversationAttachmentModel.create({
    organizationId: conversation.organizationId,
    conversationId: conversation.id,
    uploadedByUserId: conversation.userId,
    originalName: "report.csv",
    mimeType: "text/csv",
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
          mediaType: "text/csv",
          filename: "report.csv",
        },
      ],
    },
  ];

  const prevEnabled = config.skillsSandbox.enabled;
  config.skillsSandbox.enabled = false;
  let output: ChatMessage[];
  try {
    output = await materializeAttachments(input, conversation.id);
  } finally {
    config.skillsSandbox.enabled = prevEnabled;
  }

  expect(output[0].parts).toHaveLength(1);
  expect(expectPresent(output[0].parts?.[0]).type).toBe("file");
});

test("applyAnthropicCacheControl=false suppresses cache_control but still inlines the bytes", async ({
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

  const input: ChatMessage[] = [
    {
      role: "user",
      parts: [
        {
          type: "file",
          url: `/api/chat/attachments/${row.id}/content`,
          mediaType: "text/plain",
          filename: "doc.txt",
        },
      ],
    },
  ];

  const output = await materializeAttachments(
    input,
    conversation.id,
    undefined,
    false,
  );

  const filePart = expectPresent(output[0].parts?.[0]);
  // Bytes are still inlined — the data: content is NOT dropped...
  expect(filePart.url).toBe(
    `data:text/plain;base64,${bytes.toString("base64")}`,
  );
  // ...but the Anthropic-only cache_control marker is suppressed.
  expect(filePart.providerMetadata).toBeUndefined();
});

test("applyAnthropicCacheControl=false suppresses cache_control on legacy inline data: parts", async () => {
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
    undefined,
    false,
  );
  const filePart = expectPresent(output[0].parts?.[0]);
  expect(filePart.url).toBe(dataUrl);
  expect(filePart.providerMetadata).toBeUndefined();
});

test("attachment routing is unchanged when cache_control is suppressed (non-ingestible still sandbox-pointed)", async ({
  makeAgent,
  makeConversation,
}) => {
  const agent = await makeAgent();
  const conversation = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });
  const bytes = Buffer.from("SQLite header bytes", "utf8");
  const row = await ConversationAttachmentModel.create({
    organizationId: conversation.organizationId,
    conversationId: conversation.id,
    uploadedByUserId: conversation.userId,
    originalName: "orders.sqlite",
    mimeType: "application/octet-stream",
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
          mediaType: "application/octet-stream",
          filename: "orders.sqlite",
        },
      ],
    },
  ];

  // Suppressing cache_control must not add or remove the existing
  // non-ingestible → sandbox-pointer routing: same result as the cache-on path.
  const off = await materializeAttachments(
    input,
    conversation.id,
    INGESTIBLE,
    false,
  );
  const on = await materializeAttachments(
    input,
    conversation.id,
    INGESTIBLE,
    true,
  );

  for (const output of [off, on]) {
    const part = expectPresent(output[0].parts?.[0]);
    expect(part.type).toBe("text");
    expect(part.text).toContain("/home/sandbox/attachments");
    expect(part.text).not.toContain("data:");
  }
});

test("reroutes a binary document to the sandbox on a non-native Anthropic endpoint, even when the model could read it inline", async ({
  makeAgent,
  makeConversation,
}) => {
  const agent = await makeAgent();
  const conversation = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });
  const bytes = Buffer.from("%PDF-1.4 body", "utf8");
  const row = await ConversationAttachmentModel.create({
    organizationId: conversation.organizationId,
    conversationId: conversation.id,
    uploadedByUserId: conversation.userId,
    originalName: "report.pdf",
    mimeType: "application/pdf",
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
          mediaType: "application/pdf",
          filename: "report.pdf",
        },
      ],
    },
  ];

  // INGESTIBLE includes application/pdf, so the model CAN read it — but a
  // non-native Anthropic endpoint can't accept the document block, so reroute.
  const nonNative = await materializeAttachments(
    input,
    conversation.id,
    INGESTIBLE,
    true,
    true,
  );
  // Native endpoint: the document block is fine, so it stays inlined.
  const native = await materializeAttachments(
    input,
    conversation.id,
    INGESTIBLE,
    true,
    false,
  );

  const rerouted = expectPresent(nonNative[0].parts?.[0]);
  expect(rerouted.type).toBe("text");
  expect(rerouted.text).toContain("/home/sandbox/attachments");
  expect(rerouted.text).not.toContain("data:");
  expect(rerouted.url).toBeUndefined();

  const inlined = expectPresent(native[0].parts?.[0]);
  expect(inlined.type).toBe("file");
  expect(inlined.url).toBe(
    `data:application/pdf;base64,${bytes.toString("base64")}`,
  );
});

test("keeps an image inlined on a non-native Anthropic endpoint", async ({
  makeAgent,
  makeConversation,
}) => {
  const agent = await makeAgent();
  const conversation = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });
  const bytes = Buffer.from("PNG body", "utf8");
  const row = await ConversationAttachmentModel.create({
    organizationId: conversation.organizationId,
    conversationId: conversation.id,
    uploadedByUserId: conversation.userId,
    originalName: "chart.png",
    mimeType: "image/png",
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
          mediaType: "image/png",
          filename: "chart.png",
        },
      ],
    },
  ];

  // Images travel as image blocks, which the endpoint accepts — not rerouted.
  const output = await materializeAttachments(
    input,
    conversation.id,
    INGESTIBLE,
    true,
    true,
  );
  const part = expectPresent(output[0].parts?.[0]);
  expect(part.type).toBe("file");
  expect(part.url).toBe(`data:image/png;base64,${bytes.toString("base64")}`);
});

test("keeps a text-inlineable, model-readable document inlined on a non-native Anthropic endpoint", async ({
  makeAgent,
  makeConversation,
}) => {
  const agent = await makeAgent();
  const conversation = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });
  const bytes = Buffer.from("just text", "utf8");
  const row = await ConversationAttachmentModel.create({
    organizationId: conversation.organizationId,
    conversationId: conversation.id,
    uploadedByUserId: conversation.userId,
    originalName: "notes.txt",
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
          filename: "notes.txt",
        },
      ],
    },
  ];

  // text/plain is in INGESTIBLE and is text-inlineable, so the binary-doc
  // reroute must NOT touch it — it stays a file part (prepare-for-provider
  // inlines it as text later).
  const output = await materializeAttachments(
    input,
    conversation.id,
    INGESTIBLE,
    true,
    true,
  );
  const part = expectPresent(output[0].parts?.[0]);
  expect(part.type).toBe("file");
  expect(part.url).toBe(`data:text/plain;base64,${bytes.toString("base64")}`);
});

test("an inline data: binary document is dropped with a notice on a non-native endpoint", async () => {
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
    undefined,
    true,
    true,
  );
  const part = expectPresent(output[0].parts?.[0]);
  expect(part.type).toBe("text");
  // The data: bytes are NOT emitted as a document block the endpoint rejects.
  expect(part.text).not.toContain("data:");
  expect(part.url).toBeUndefined();
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
