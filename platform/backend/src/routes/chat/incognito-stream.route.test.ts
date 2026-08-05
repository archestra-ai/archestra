// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
/**
 * Contract under test — the streaming half of incognito conversations
 * (POST /api/chat):
 * - the browser-held key header is required up front: a missing key is a 400
 *   and a wrong key a 409, both BEFORE any message row is written
 * - with the right key, every persisted messages.content row (the early user
 *   message persist and the onFinish assistant persist alike) is an
 *   encryption envelope, never plaintext
 * - the same key decrypts the transcript back through the GET route
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { vi } from "vitest";
import config from "@/config";
import {
  _resetContentKeys,
  // biome-ignore lint/style/noRestrictedImports: dual-licensed code under test
} from "@/content-encryption/index.ee";
import db from "@/database";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ESCROW_PEM = publicKey.export({ type: "spki", format: "pem" }) as string;

const KEY_HEADER = "x-archestra-incognito-key";

// Minimal slice of the stream-route.test.ts harness: the model boundary
// ("ai" + llm-client), the MCP tool boundary, and the side channels the
// route always touches (ingestion, tracing span, compaction, the
// reasoning-summary negative cache that reads the unstarted distributed
// cache). Everything else — active run service, hooks, persistence — runs
// real against PGlite.
const mockCreateUIMessageStream = vi.hoisted(() => vi.fn());
const mockCreateUIMessageStreamResponse = vi.hoisted(() => vi.fn());
const mockStreamText = vi.hoisted(() => vi.fn());
const mockCreateLLMModelForAgent = vi.hoisted(() => vi.fn());
const mockGetChatMcpTools = vi.hoisted(() => vi.fn());
const mockGetChatMcpToolUiResourceUris = vi.hoisted(() => vi.fn());
const mockFetchToolUiResource = vi.hoisted(() => vi.fn());
const mockExtractAndIngestDocuments = vi.hoisted(() => vi.fn());
const mockStartActiveChatSpan = vi.hoisted(() => vi.fn());
const mockCompactMessagesForChat = vi.hoisted(() => vi.fn());
const mockIsOpenAiReasoningSummaryMarkedUnsupported = vi.hoisted(() => vi.fn());

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    createUIMessageStream: mockCreateUIMessageStream,
    createUIMessageStreamResponse: mockCreateUIMessageStreamResponse,
    streamText: mockStreamText,
    convertToModelMessages: vi.fn(async (messages) => messages),
  };
});

vi.mock("@/clients/llm-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/clients/llm-client")>();
  return {
    ...actual,
    createLLMModelForAgent: mockCreateLLMModelForAgent,
  };
});

vi.mock("@/clients/chat-mcp-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/clients/chat-mcp-client")>();
  return {
    ...actual,
    getChatMcpTools: mockGetChatMcpTools,
    getChatMcpToolUiResourceUris: mockGetChatMcpToolUiResourceUris,
    fetchToolUiResource: mockFetchToolUiResource,
  };
});

vi.mock("@/knowledge-base", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/knowledge-base")>();
  return {
    ...actual,
    extractAndIngestDocuments: mockExtractAndIngestDocuments,
  };
});

vi.mock("@/observability/tracing", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/observability/tracing")>();
  return {
    ...actual,
    startActiveChatSpan: mockStartActiveChatSpan,
  };
});

vi.mock("@/agents/openai-reasoning-summary", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/agents/openai-reasoning-summary")>();
  return {
    ...actual,
    isOpenAiReasoningSummaryMarkedUnsupported:
      mockIsOpenAiReasoningSummaryMarkedUnsupported,
  };
});

vi.mock("./context-compaction", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./context-compaction")>();
  return {
    ...actual,
    compactMessagesForChat: mockCompactMessagesForChat,
  };
});

describe("POST /api/chat (incognito)", () => {
  let app: FastifyInstanceWithZod;
  let currentUser: User;
  let organizationId: string;
  let agentId: string;
  let dek: Buffer;
  let capturedInnerOnFinish:
    | ((args: { messages: unknown[] }) => Promise<void> | void)
    | undefined;
  let executionPromise: Promise<void> | undefined;

  beforeEach(async ({ makeAgent, makeMember, makeOrganization, makeUser }) => {
    config.enterpriseFeatures.core = true;
    config.chatIncognito.escrowPublicKey = ESCROW_PEM;
    // Force server-side content encryption at rest OFF (a local .env may set
    // ARCHESTRA_CONTENT_ENCRYPTION_SECRET): the envelope these tests assert on
    // must be the browser-DEK one — with a server key active, a broken DEK
    // threading could hide behind server-key envelopes. Auto-restored.
    config.contentEncryption.secret = undefined;
    _resetContentKeys();
    dek = randomBytes(32);
    capturedInnerOnFinish = undefined;
    executionPromise = undefined;

    currentUser = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(currentUser.id, organizationId, { role: "admin" });
    const agent = await makeAgent({
      organizationId,
      authorId: currentUser.id,
      scope: "personal",
    });
    agentId = agent.id;

    mockCreateLLMModelForAgent.mockResolvedValue({ model: "mock-model" });
    mockGetChatMcpTools.mockResolvedValue({});
    mockGetChatMcpToolUiResourceUris.mockResolvedValue({});
    mockExtractAndIngestDocuments.mockResolvedValue(undefined);
    mockCompactMessagesForChat.mockImplementation(
      async ({ messages }: { messages: unknown[] }) => ({
        messages,
        status: "skipped",
        compaction: null,
        reason: "below_threshold",
      }),
    );
    mockStartActiveChatSpan.mockImplementation(
      async ({ callback }: { callback: () => Promise<Response> }) => callback(),
    );

    mockStreamText.mockImplementation(() => ({
      toUIMessageStream: (opts: {
        onFinish?: (args: { messages: unknown[] }) => Promise<void> | void;
      }) => {
        capturedInnerOnFinish = opts.onFinish;
        return new ReadableStream({
          start(controller) {
            controller.close();
          },
        });
      },
      textStream: {
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ done: true, value: undefined }),
        }),
      },
      // The route probes fullStream for the first renderable event before
      // merging; yield one so the probe proceeds to the merge.
      fullStream: {
        [Symbol.asyncIterator]: () => {
          const events = [
            { type: "text-delta", text: "" },
            { type: "finish", finishReason: "stop" },
          ];
          let index = 0;
          return {
            next: async () =>
              index < events.length
                ? { done: false, value: events[index++] }
                : { done: true, value: undefined },
          };
        },
      },
      usage: Promise.resolve(null),
    }));

    mockCreateUIMessageStream.mockImplementation(
      ({
        execute,
      }: {
        execute: (args: {
          writer: { write: (x: unknown) => void; merge: (s: unknown) => void };
        }) => Promise<void>;
      }) => {
        const writer = { write: vi.fn(), merge: vi.fn() };
        executionPromise = execute({ writer }).catch(() => undefined);
        return new ReadableStream({
          start(controller) {
            controller.close();
          },
        });
      },
    );

    mockCreateUIMessageStreamResponse.mockImplementation(
      ({ stream }: { stream: ReadableStream }) =>
        new Response(stream, {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    );

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = currentUser;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: chatRoutes } = await import("./routes");
    await app.register(chatRoutes);
  });

  afterEach(async () => {
    // The shared teardown restores the pristine config after this hook;
    // clear the derived-key cache so later consumers re-derive from it.
    _resetContentKeys();
    await app.close();
  });

  function dekHeader(key: Buffer = dek) {
    return { [KEY_HEADER]: key.toString("base64url") };
  }

  async function createIncognitoConversation(): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/api/chat/conversations",
      headers: dekHeader(),
      payload: { agentId, incognito: true },
    });
    expect(response.statusCode).toBe(200);
    return response.json().id as string;
  }

  /** Every stored content row with a flag telling whether it is an envelope. */
  async function messageRows(conversationId: string) {
    const result = await db.execute<{
      role: string;
      content_text: string;
      is_envelope: boolean;
    }>(
      sql`SELECT role, content::text AS content_text, (content ? '__encrypted') AS is_envelope
          FROM messages WHERE conversation_id = ${conversationId}::uuid
          ORDER BY created_at`,
    );
    return result.rows;
  }

  const userMessage = {
    id: "msg-user-1",
    role: "user",
    parts: [{ type: "text", text: "the incognito question" }],
  };

  test("persists every message as an envelope and decrypts them back with the key", async () => {
    const conversationId = await createIncognitoConversation();

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: dekHeader(),
      payload: { id: conversationId, messages: [userMessage] },
    });
    expect(response.statusCode).toBe(200);
    await executionPromise;

    // The user message was persisted early (before the model stream ends) —
    // already as an envelope, never plaintext-then-rewritten.
    const earlyRows = await messageRows(conversationId);
    expect(earlyRows).toHaveLength(1);
    expect(earlyRows[0].is_envelope).toBe(true);

    // Drive the stream to completion: onFinish persists the assistant turn.
    expect(capturedInnerOnFinish).toBeDefined();
    await capturedInnerOnFinish?.({
      messages: [
        userMessage,
        {
          id: "msg-assistant-1",
          role: "assistant",
          parts: [{ type: "text", text: "the incognito answer" }],
        },
      ],
    });

    const rows = await messageRows(conversationId);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.is_envelope).toBe(true);
      expect(row.content_text).not.toContain("the incognito question");
      expect(row.content_text).not.toContain("the incognito answer");
    }

    // The same key opens the transcript back through the GET route.
    const unlocked = await app.inject({
      method: "GET",
      url: `/api/chat/conversations/${conversationId}`,
      headers: dekHeader(),
    });
    expect(unlocked.statusCode).toBe(200);
    const texts = (
      unlocked.json().messages as Array<{
        parts: Array<{ type: string; text?: string }>;
      }>
    ).map((message) => message.parts[0]?.text);
    expect(texts).toEqual(["the incognito question", "the incognito answer"]);
  });

  test("rejects a missing key with 400 before any message row is written", async () => {
    const conversationId = await createIncognitoConversation();

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { id: conversationId, messages: [userMessage] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain(KEY_HEADER);

    expect(await messageRows(conversationId)).toHaveLength(0);
  });

  test("rejects a wrong 32-byte key with 409 before any message row is written", async () => {
    const conversationId = await createIncognitoConversation();

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: dekHeader(randomBytes(32)),
      payload: { id: conversationId, messages: [userMessage] },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toContain("does not match");

    expect(await messageRows(conversationId)).toHaveLength(0);
  });
});
