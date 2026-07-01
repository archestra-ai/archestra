import { INLINE_TEXT_MAX_BYTES } from "@archestra/shared";
import { describe } from "vitest";
import ConversationAttachmentModel from "@/models/conversation-attachment";
import { expect, test } from "@/test";
import type { ChatMessage } from "@/types";
import {
  assertInlineAttachmentsAcceptable,
  extractInlineAttachments,
  type InlineAttachmentPolicy,
  isAttachmentRefUrl,
  parseAttachmentIdFromUrl,
} from "./extract-inline-attachments";

function makeDataUrl(mime: string, bytes: Buffer): string {
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

function expectPresent<T>(value: T | null | undefined): T {
  expect(value).toBeDefined();
  if (value == null) {
    throw new Error("Expected value to be present");
  }
  return value;
}

test("rewrites data: URL file part to attachment ref and persists bytes", async ({
  makeAgent,
  makeConversation,
}) => {
  const agent = await makeAgent();
  const conversation = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });
  const bytes = Buffer.from("hello world", "utf8");

  const messages: ChatMessage[] = [
    {
      id: "m1",
      role: "user",
      parts: [
        { type: "text", text: "Look at this" },
        {
          type: "file",
          url: makeDataUrl("text/plain", bytes),
          mediaType: "text/plain",
          filename: "hello.txt",
        },
      ],
    },
  ];

  await extractInlineAttachments({
    messages,
    conversationId: conversation.id,
    organizationId: conversation.organizationId,
    uploadedByUserId: conversation.userId,
  });

  const filePart = expectPresent(messages[0].parts?.[1]);
  expect(filePart.type).toBe("file");
  expect(filePart.url).toBeDefined();
  const url = filePart.url as string;
  expect(isAttachmentRefUrl(url)).toBe(true);

  const id = expectPresent(parseAttachmentIdFromUrl(url));

  const row = expectPresent(
    await ConversationAttachmentModel.findByIdWithData(id),
  );
  expect(row.fileData.equals(bytes)).toBe(true);
  expect(row.originalName).toBe("hello.txt");
  expect(row.mimeType).toBe("text/plain");
  expect(filePart.fileSize).toBe(bytes.byteLength);
});

test("re-sending the same bytes within one conversation reuses the row", async ({
  makeAgent,
  makeConversation,
}) => {
  const agent = await makeAgent();
  const conversation = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });
  const bytes = Buffer.from("identical", "utf8");
  const dataUrl = makeDataUrl("text/plain", bytes);

  const turn1: ChatMessage[] = [
    {
      role: "user",
      parts: [
        {
          type: "file",
          url: dataUrl,
          mediaType: "text/plain",
          filename: "a.txt",
        },
      ],
    },
  ];
  const turn2: ChatMessage[] = [
    {
      role: "user",
      parts: [
        {
          type: "file",
          url: dataUrl,
          mediaType: "text/plain",
          filename: "a.txt",
        },
      ],
    },
  ];

  await extractInlineAttachments({
    messages: turn1,
    conversationId: conversation.id,
    organizationId: conversation.organizationId,
    uploadedByUserId: conversation.userId,
  });
  await extractInlineAttachments({
    messages: turn2,
    conversationId: conversation.id,
    organizationId: conversation.organizationId,
    uploadedByUserId: conversation.userId,
  });

  const id1 = parseAttachmentIdFromUrl(
    expectPresent(turn1[0].parts?.[0]).url as string,
  );
  const id2 = parseAttachmentIdFromUrl(
    expectPresent(turn2[0].parts?.[0]).url as string,
  );
  expect(id1).toBe(id2);
});

test("same bytes in different conversations are stored independently", async ({
  makeAgent,
  makeConversation,
}) => {
  const agent = await makeAgent();
  const convo1 = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });
  const convo2 = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });
  const bytes = Buffer.from("identical-cross-convo", "utf8");
  const dataUrl = makeDataUrl("text/plain", bytes);

  const messages1: ChatMessage[] = [
    {
      role: "user",
      parts: [
        {
          type: "file",
          url: dataUrl,
          mediaType: "text/plain",
          filename: "x.txt",
        },
      ],
    },
  ];
  const messages2: ChatMessage[] = [
    {
      role: "user",
      parts: [
        {
          type: "file",
          url: dataUrl,
          mediaType: "text/plain",
          filename: "y.txt",
        },
      ],
    },
  ];

  await extractInlineAttachments({
    messages: messages1,
    conversationId: convo1.id,
    organizationId: convo1.organizationId,
    uploadedByUserId: convo1.userId,
  });
  await extractInlineAttachments({
    messages: messages2,
    conversationId: convo2.id,
    organizationId: convo2.organizationId,
    uploadedByUserId: convo2.userId,
  });

  const id1 = expectPresent(
    parseAttachmentIdFromUrl(
      expectPresent(messages1[0].parts?.[0]).url as string,
    ),
  );
  const id2 = expectPresent(
    parseAttachmentIdFromUrl(
      expectPresent(messages2[0].parts?.[0]).url as string,
    ),
  );
  expect(id1).not.toBe(id2);

  const r1 = await ConversationAttachmentModel.findById(id1);
  const r2 = await ConversationAttachmentModel.findById(id2);
  expect(r1?.conversationId).toBe(convo1.id);
  expect(r2?.conversationId).toBe(convo2.id);
  expect(r1?.originalName).toBe("x.txt");
  expect(r2?.originalName).toBe("y.txt");
});

test("non-file parts and non-data URLs pass through unchanged", async ({
  makeAgent,
  makeConversation,
}) => {
  const agent = await makeAgent();
  const conversation = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });

  const messages: ChatMessage[] = [
    {
      role: "user",
      parts: [
        { type: "text", text: "no attachment here" },
        {
          type: "file",
          url: "https://cdn.example.com/already-hosted.pdf",
          mediaType: "application/pdf",
          filename: "remote.pdf",
        },
      ],
    },
  ];
  const before = JSON.parse(JSON.stringify(messages));

  await extractInlineAttachments({
    messages,
    conversationId: conversation.id,
    organizationId: conversation.organizationId,
    uploadedByUserId: conversation.userId,
  });

  expect(messages).toEqual(before);
});

test("text-like mime types get textPreview populated", async ({
  makeAgent,
  makeConversation,
}) => {
  const agent = await makeAgent();
  const conversation = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });
  const bytes = Buffer.from("name,age\nAlice,30\nBob,25", "utf8");

  const messages: ChatMessage[] = [
    {
      role: "user",
      parts: [
        {
          type: "file",
          url: makeDataUrl("text/csv", bytes),
          mediaType: "text/csv",
          filename: "data.csv",
        },
      ],
    },
  ];

  await extractInlineAttachments({
    messages,
    conversationId: conversation.id,
    organizationId: conversation.organizationId,
    uploadedByUserId: conversation.userId,
  });

  const id = expectPresent(
    parseAttachmentIdFromUrl(
      expectPresent(messages[0].parts?.[0]).url as string,
    ),
  );
  const row = await ConversationAttachmentModel.findById(id);
  expect(row?.textPreviewStatus).toBe("ok");
  expect(row?.textPreview).toBe("name,age\nAlice,30\nBob,25");
});

test("skips messages already persisted on a prior turn (legacy data: URLs in history)", async ({
  makeAgent,
  makeConversation,
}) => {
  const agent = await makeAgent();
  const conversation = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });
  const legacyBytes = Buffer.from("LEGACY_CONTENT", "utf8");
  const freshBytes = Buffer.from("FRESH_CONTENT", "utf8");

  const messages: ChatMessage[] = [
    // Legacy turn: re-sent by FE with persistedMessageId metadata. Extract
    // must leave this alone — re-decoding + re-hashing on every send is
    // wasted work, and persistNewMessages won't rewrite the persisted row.
    {
      id: "legacy-msg",
      role: "user",
      metadata: { persistedMessageId: "db-uuid-legacy" },
      parts: [
        {
          type: "file",
          url: makeDataUrl("text/plain", legacyBytes),
          mediaType: "text/plain",
          filename: "legacy.txt",
        },
      ],
    },
    // Fresh turn: no persistedMessageId. Extract should rewrite this one.
    {
      id: "fresh-msg",
      role: "user",
      parts: [
        {
          type: "file",
          url: makeDataUrl("text/plain", freshBytes),
          mediaType: "text/plain",
          filename: "fresh.txt",
        },
      ],
    },
  ];

  await extractInlineAttachments({
    messages,
    conversationId: conversation.id,
    organizationId: conversation.organizationId,
    uploadedByUserId: conversation.userId,
  });

  // Legacy part is left as-is (still a data URL).
  const legacyPart = expectPresent(messages[0].parts?.[0]);
  expect((legacyPart.url as string).startsWith("data:")).toBe(true);

  // Fresh part is rewritten to a ref.
  const freshPart = expectPresent(messages[1].parts?.[0]);
  expect(isAttachmentRefUrl(freshPart.url as string)).toBe(true);

  // Only ONE row was created (for the fresh message) — confirms we did not
  // burn a hash+DB-hit on the legacy turn.
  const rows =
    await ConversationAttachmentModel.findByConversationIdWithoutData(
      conversation.id,
    );
  expect(rows.length).toBe(1);
  expect(rows[0].originalName).toBe("fresh.txt");
});

test("parseAttachmentIdFromUrl validates the URL shape", () => {
  const valid =
    "/api/chat/attachments/11111111-1111-4111-9111-111111111111/content";
  expect(parseAttachmentIdFromUrl(valid)).toBe(
    "11111111-1111-4111-9111-111111111111",
  );

  expect(
    parseAttachmentIdFromUrl("/api/chat/attachments/not-a-uuid/content"),
  ).toBeNull();
  expect(
    parseAttachmentIdFromUrl("data:application/pdf;base64,xxx"),
  ).toBeNull();
  expect(
    parseAttachmentIdFromUrl("/api/other/attachments/abc/content"),
  ).toBeNull();
});

describe("assertInlineAttachmentsAcceptable", () => {
  const SANDBOX_LIMIT = 16 * 1024 * 1024;

  function policy(
    overrides: Partial<InlineAttachmentPolicy> = {},
  ): InlineAttachmentPolicy {
    return {
      ingestibleMimeTypes: new Set(["image/png", "application/pdf"]),
      sandboxAvailable: false,
      sandboxByteLimit: SANDBOX_LIMIT,
      ...overrides,
    };
  }

  function messageWith(mime: string, byteLength: number): ChatMessage[] {
    return [
      {
        role: "user",
        parts: [
          {
            type: "file",
            url: makeDataUrl(mime, Buffer.alloc(byteLength, 0x61)),
            mediaType: mime,
            filename: `file.${mime.split("/")[1]}`,
          },
        ],
      },
    ];
  }

  function assert(mime: string, byteLength: number, p: InlineAttachmentPolicy) {
    assertInlineAttachmentsAcceptable({
      messages: messageWith(mime, byteLength),
      policy: p,
    });
  }

  test("accepts a model-ingestible type regardless of sandbox", () => {
    expect(() => assert("image/png", 5_000_000, policy())).not.toThrow();
  });

  test("accepts a small inlineable text file without a sandbox", () => {
    expect(() =>
      assert("application/x-yaml", INLINE_TEXT_MAX_BYTES, policy()),
    ).not.toThrow();
  });

  test("rejects an oversized text file when no sandbox is available", () => {
    expect(() =>
      assert("text/csv", INLINE_TEXT_MAX_BYTES + 1, policy()),
    ).toThrow();
  });

  test("routes an oversized text file to the sandbox when available", () => {
    expect(() =>
      assert(
        "text/csv",
        INLINE_TEXT_MAX_BYTES + 1,
        policy({ sandboxAvailable: true }),
      ),
    ).not.toThrow();
  });

  test("rejects an unsupported binary type without a sandbox", () => {
    expect(() => assert("application/zip", 1_000, policy())).toThrow();
  });

  test("accepts an arbitrary type within the limit when the sandbox is available", () => {
    expect(() =>
      assert("application/zip", 1_000, policy({ sandboxAvailable: true })),
    ).not.toThrow();
  });

  test("rejects a file over the sandbox artifact limit even when available", () => {
    expect(() =>
      assert(
        "application/zip",
        SANDBOX_LIMIT + 1,
        policy({ sandboxAvailable: true }),
      ),
    ).toThrow();
  });

  test("does not throw on a malformed (un-decodable) data: URL", () => {
    // A bad percent-escape can't be sized; the gate must skip it (extraction's
    // own per-part catch handles the bad URL) rather than throw a raw URIError.
    const messages: ChatMessage[] = [
      {
        role: "user",
        parts: [
          { type: "file", url: "data:text/plain,%E0%A4%A", filename: "x.txt" },
        ],
      },
    ];
    expect(() =>
      assertInlineAttachmentsAcceptable({ messages, policy: policy() }),
    ).not.toThrow();
  });
});
