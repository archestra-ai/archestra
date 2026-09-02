import {
  ChatErrorCode,
  CLAUDE_CLIENT_FILTER,
  CLAUDE_CLIENT_ID,
  CLAUDE_DESKTOP_CLIENT_ID,
  CODEX_CLIENT_FILTER,
  CODEX_CLIENT_ID,
} from "@archestra/shared";
import ConversationModel from "@/models/conversation";
import ConversationChatErrorModel from "@/models/conversation-chat-error";
import InteractionModel from "@/models/interaction";
import InteractionDeltaManager from "@/models/interaction-delta-manager";
import KnowledgeBaseConnectorModel from "@/models/knowledge-base-connector";
import VirtualApiKeyModel from "@/models/virtual-api-key";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { InsertInteraction, InteractionResponse, User } from "@/types";

describe("interaction routes", () => {
  let app: FastifyInstanceWithZod;
  let currentUser: User;
  let organizationId: string;

  beforeEach(async ({ makeAdmin, makeOrganization, makeMember }) => {
    currentUser = await makeAdmin();
    const organization = await makeOrganization();
    organizationId = organization.id;
    // The routes resolve log:admin from the caller's org membership; the
    // suite's default caller is an org admin (org-wide log visibility).
    await makeMember(currentUser.id, organizationId, { role: "admin" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = currentUser;
      (
        request as typeof request & {
          organizationId: string;
        }
      ).organizationId = organizationId;
    });

    const { default: interactionRoutes } = await import("./interaction");
    await app.register(interactionRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("lists interactions without requiring chat errors", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({
      organizationId,
      authorId: currentUser.id,
      scope: "org",
    });
    await InteractionModel.create({
      profileId: agent.id,
      request: {
        model: "gpt-4",
        messages: [{ role: "user", content: "Hello" }],
      },
      response: {
        id: "test-response",
        object: "chat.completion",
        created: Date.now(),
        model: "gpt-4",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Hi there",
              refusal: null,
            },
            finish_reason: "stop",
            logprobs: null,
          },
        ],
      },
      type: "openai:chatCompletions",
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/interactions?limit=10&offset=0&sortBy=createdAt&sortDirection=desc",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveLength(1);
  });

  test("lists interactions whose response carries a non-standard finish_reason", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({
      organizationId,
      authorId: currentUser.id,
      scope: "org",
    });
    // Models fronted by OpenRouter can emit finish_reason values outside the
    // canonical OpenAI set; the stored row must still serialize on read-back.
    await InteractionModel.create({
      profileId: agent.id,
      request: {
        model: "minimax/minimax-m3",
        messages: [{ role: "user", content: "Hello" }],
      },
      response: {
        id: "test-response",
        object: "chat.completion",
        created: Date.now(),
        model: "minimax/minimax-m3",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Hi there",
              refusal: null,
            },
            finish_reason: "unusual_reason",
            logprobs: null,
          },
        ],
      },
      type: "openai:chatCompletions",
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/interactions?limit=10&offset=0&sortBy=createdAt&sortDirection=desc",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveLength(1);
    expect(response.json().data[0].response.choices[0].finish_reason).toBe(
      "unusual_reason",
    );
  });

  test("lists an interaction whose stored request no longer matches the provider schema", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({
      organizationId,
      authorId: currentUser.id,
      scope: "org",
    });
    // Persisted gemini rows exist whose request lacks `contents` (provider-
    // schema drift / partial delta reconstruction). The row must serialize
    // raw on read-back instead of 500-ing the whole list.
    await InteractionModel.create({
      profileId: agent.id,
      request: {
        generationConfig: { temperature: 0 },
      } as unknown as InsertInteraction["request"],
      response: {
        error: "Upstream provider returned an error response",
      } as unknown as InteractionResponse,
      type: "gemini:generateContent",
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/interactions?limit=10&offset=0&sortBy=createdAt&sortDirection=desc",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveLength(1);
    expect(response.json().data[0].request).toEqual({
      generationConfig: { temperature: 0 },
    });
  });

  test("lists an interaction whose response is an upstream-error object", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({
      organizationId,
      authorId: currentUser.id,
      scope: "org",
    });
    // A failed upstream LLM call is persisted with the provider's interaction
    // type but a response of `{ error }` (llm-proxy-handler.ts). The row must
    // still serialize on read-back instead of 500-ing the whole list.
    await InteractionModel.create({
      profileId: agent.id,
      request: {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 64,
        messages: [{ role: "user", content: "Hello" }],
      },
      response: {
        error: "Upstream provider returned an error response",
      } as unknown as InteractionResponse,
      type: "anthropic:messages",
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/interactions?limit=10&offset=0&sortBy=createdAt&sortDirection=desc",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveLength(1);
    expect(response.json().data[0].response).toEqual({
      error: "Upstream provider returned an error response",
    });
  });

  test("normalizes a stored response that matches no provider schema", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({
      organizationId,
      authorId: currentUser.id,
      scope: "org",
    });
    // Provider-schema drift / partial-stream bodies / legacy shapes: a response
    // that is neither a valid provider response nor `{ error }` must not 500 the
    // whole list — the model coerces it to a serializable sentinel.
    await InteractionModel.create({
      profileId: agent.id,
      request: {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 64,
        messages: [{ role: "user", content: "Hello" }],
      },
      response: {
        unexpected: "shape",
      } as unknown as InteractionResponse,
      type: "anthropic:messages",
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/interactions?limit=10&offset=0&sortBy=createdAt&sortDirection=desc",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveLength(1);
    expect(response.json().data[0].response).toEqual({
      error: "Malformed stored interaction response",
    });
  });

  test("serializes an error-response interaction on the detail route", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({
      organizationId,
      authorId: currentUser.id,
      scope: "org",
    });
    const interaction = await InteractionModel.create({
      profileId: agent.id,
      request: {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 64,
        messages: [{ role: "user", content: "Hello" }],
      },
      response: {
        error: "Upstream provider returned an error response",
      } as unknown as InteractionResponse,
      type: "anthropic:messages",
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/interactions/${interaction.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().response).toEqual({
      error: "Upstream provider returned an error response",
    });
  });

  test("serializes a gemini:embeddings interaction (OpenAI-compatible shape)", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({
      organizationId,
      authorId: currentUser.id,
      scope: "org",
    });
    // Gemini embeddings are persisted via the OpenAI-compatible embedding
    // client; the read schema must model this type or the whole list 500s.
    await InteractionModel.create({
      profileId: agent.id,
      request: { model: "text-embedding-004", input: ["hello"] },
      response: {
        object: "list",
        data: [{ object: "embedding", embedding: [0.1, 0.2], index: 0 }],
        model: "text-embedding-004",
        usage: { prompt_tokens: 1, total_tokens: 1 },
      },
      type: "gemini:embeddings",
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/interactions?limit=10&offset=0&sortBy=createdAt&sortDirection=desc",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveLength(1);
    expect(response.json().data[0].type).toBe("gemini:embeddings");
  });

  test("preserves the truncated embedding-preview marker through serialization", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({
      organizationId,
      authorId: currentUser.id,
      scope: "org",
    });
    // Embedding interactions store a truncated vector preview: the first few
    // values plus `truncatedFrom` = the full length. The read schema must model
    // the marker or Fastify serialization would silently strip it.
    await InteractionModel.create({
      profileId: agent.id,
      request: { model: "amazon.titan-embed-text-v2:0", input: ["hello"] },
      response: {
        object: "list",
        data: [
          {
            object: "embedding",
            embedding: [0.1, 0.2, 0.3],
            index: 0,
            truncatedFrom: 1024,
          },
        ],
        model: "amazon.titan-embed-text-v2:0",
        usage: { prompt_tokens: 1, total_tokens: 1 },
      },
      type: "bedrock:embeddings",
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/interactions?limit=10&offset=0&sortBy=createdAt&sortDirection=desc",
    });

    expect(response.statusCode).toBe(200);
    const item = response.json().data[0];
    expect(item.type).toBe("bedrock:embeddings");
    expect(item.response.data[0].truncatedFrom).toBe(1024);
    expect(item.response.data[0].embedding).toEqual([0.1, 0.2, 0.3]);
  });

  test("returns chat errors on interaction detail for chat sessions", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({
      organizationId,
      authorId: currentUser.id,
      scope: "org",
    });
    const conversation = await ConversationModel.create({
      userId: currentUser.id,
      organizationId,
      agentId: agent.id,
    });
    await ConversationChatErrorModel.create({
      conversationId: conversation.id,
      error: {
        code: ChatErrorCode.ServerError,
        message: "Provider failed.",
        isRetryable: true,
      },
    });
    const interaction = await InteractionModel.create({
      profileId: agent.id,
      sessionId: conversation.id,
      request: {
        model: "gpt-4",
        messages: [{ role: "user", content: "Hello" }],
      },
      response: {
        id: "test-response",
        object: "chat.completion",
        created: Date.now(),
        model: "gpt-4",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Hi there",
              refusal: null,
            },
            finish_reason: "stop",
            logprobs: null,
          },
        ],
      },
      type: "openai:chatCompletions",
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/interactions/${interaction.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().chatErrors).toEqual([
      expect.objectContaining({
        conversationId: conversation.id,
        error: {
          code: ChatErrorCode.ServerError,
          message: "Provider failed.",
          isRetryable: true,
        },
      }),
    ]);
  });

  test("returns fully reconstructed request for delta-encoded Claude interactions", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({
      organizationId,
      authorId: currentUser.id,
      scope: "org",
    });

    const anthropicResponse = {
      id: "msg_test",
      type: "message",
      container: null,
      role: "assistant",
      content: [{ type: "text", text: "ok", citations: [] }],
      model: "claude-3-5-sonnet",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    };
    const m0 = { role: "user", content: "first message in the claude session" };
    // The tip's own delta suffix carries no user TEXT (tool_result-only), so
    // the preview's text exists only in the head row — a suffix-only
    // (unreconstructed) read would yield a null preview.
    const fullMessages = [
      m0,
      { role: "assistant", content: "ack" },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }],
      },
    ];

    const anthropicReq = (messages: unknown[]) =>
      ({
        model: "claude-3-5-sonnet",
        max_tokens: 1024,
        messages,
      }) as unknown as InsertInteraction["request"];
    const anthropicResp =
      anthropicResponse as unknown as InsertInteraction["response"];

    await InteractionModel.create({
      profileId: agent.id,
      sessionId: "route-delta-session",
      sessionSource: "claude_metadata",
      type: "anthropic:messages",
      request: anthropicReq([m0]),
      response: anthropicResp,
      // Explicit distinct timestamps: defaultNow() can tie within the same
      // millisecond, and the last-interaction window ranks by created_at
      // alone — a tie could select the head row and dodge tip reconstruction.
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    const tip = await InteractionModel.create({
      profileId: agent.id,
      sessionId: "route-delta-session",
      sessionSource: "claude_metadata",
      type: "anthropic:messages",
      request: anthropicReq(fullMessages),
      response: anthropicResp,
      createdAt: new Date("2020-01-01T00:00:01.000Z"),
    });

    // Sessions endpoint derives its preview from the reconstructed request —
    // the raw request body itself is never returned by the listing (T-1015:
    // shipping full bodies OOM-killed the platform container). Runs FIRST, on
    // a cold delta cache, so the preview provably comes from DB
    // reconstruction rather than tip state warmed by the writes above.
    InteractionDeltaManager.reset();
    const sessions = await app.inject({
      method: "GET",
      url: "/api/interactions/sessions?limit=10&sessionId=route-delta-session",
    });
    expect(sessions.statusCode).toBe(200);
    const sessionRow = sessions.json().data[0];
    expect(sessionRow.lastUserMessagePreview).toBe(
      "first message in the claude session",
    );
    expect(sessionRow).not.toHaveProperty("lastInteractionRequest");

    // Detail endpoint reconstructs the full request and passes response
    // schema. Cold cache again: the sessions call above warmed the tip.
    InteractionDeltaManager.reset();
    const detail = await app.inject({
      method: "GET",
      url: `/api/interactions/${tip.id}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().request.messages).toEqual(fullMessages);

    // Session-filtered list reconstructs every interaction's request — also
    // from a cold cache.
    InteractionDeltaManager.reset();
    const list = await app.inject({
      method: "GET",
      url: "/api/interactions?limit=10&offset=0&sortBy=createdAt&sortDirection=desc&sessionId=route-delta-session",
    });
    expect(list.statusCode).toBe(200);
    const tipRow = list
      .json()
      .data.find((i: { id: string }) => i.id === tip.id);
    expect(tipRow.request.messages).toEqual(fullMessages);
  });

  test("filters the sessions endpoint by client (external_agent_id)", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({
      organizationId,
      authorId: currentUser.id,
      scope: "org",
    });

    const openaiResp = {
      id: "r",
      object: "chat.completion" as const,
      created: Date.now(),
      model: "gpt-4",
      choices: [],
    } as unknown as InsertInteraction["response"];
    const make = (sessionId: string, externalAgentId: string | null) =>
      InteractionModel.create({
        profileId: agent.id,
        sessionId,
        externalAgentId,
        source: "api",
        request: {
          model: "gpt-4",
          messages: [],
        } as unknown as InsertInteraction["request"],
        response: openaiResp,
        type: "openai:chatCompletions",
      });

    await make("auto", CLAUDE_CLIENT_ID);
    await make("desktop", CLAUDE_DESKTOP_CLIENT_ID);
    await make("codex", CODEX_CLIENT_ID);
    await make("customer", "my-custom-agent");

    // The Claude filter expands to every Claude client id → both Claude sessions.
    const filtered = await app.inject({
      method: "GET",
      url: `/api/interactions/sessions?limit=50&client=${CLAUDE_CLIENT_FILTER}`,
    });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json().data).toHaveLength(2);

    // The Codex filter → the single Codex session.
    const codex = await app.inject({
      method: "GET",
      url: `/api/interactions/sessions?limit=50&client=${CODEX_CLIENT_FILTER}`,
    });
    expect(codex.statusCode).toBe(200);
    expect(codex.json().data).toHaveLength(1);
    expect(codex.json().data[0].externalAgentIds).toEqual([CODEX_CLIENT_ID]);

    // No filter → all four sessions.
    const all = await app.inject({
      method: "GET",
      url: "/api/interactions/sessions?limit=50",
    });
    expect(all.statusCode).toBe(200);
    expect(all.json().data).toHaveLength(4);
  });

  test("cursor-paginates distinct sessions plus sessionless interactions", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({
      organizationId,
      authorId: currentUser.id,
      scope: "org",
    });

    const make = (sessionId: string | null) =>
      InteractionModel.create({
        profileId: agent.id,
        sessionId,
        source: "api",
        request: {
          model: "gpt-4",
          messages: [],
        } as unknown as InsertInteraction["request"],
        response: {
          id: "r",
          object: "chat.completion" as const,
          created: Date.now(),
          model: "gpt-4",
          choices: [],
        } as unknown as InsertInteraction["response"],
        type: "openai:chatCompletions",
      });

    // Two interactions in the same session, one in another session, and two
    // sessionless interactions (each counts as its own "session").
    await make("shared-session");
    await make("shared-session");
    await make("other-session");
    await make(null);
    await make(null);

    const response = await app.inject({
      method: "GET",
      url: "/api/interactions/sessions?limit=2",
    });

    expect(response.statusCode).toBe(200);
    const first = response.json();
    expect(first.data).toHaveLength(2);
    expect(first.pagination.hasNext).toBe(true);

    const next = await app.inject({
      method: "GET",
      url: `/api/interactions/sessions?limit=2&cursor=${encodeURIComponent(first.pagination.nextCursor)}`,
    });
    expect(next.statusCode).toBe(200);
    expect(next.json().data).toHaveLength(2);
    expect(next.json().pagination).toMatchObject({
      hasNext: false,
      nextCursor: null,
    });
  });

  test("walks tied session heads once when interactions straddle page boundaries", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({
      organizationId,
      authorId: currentUser.id,
      scope: "org",
    });
    const create = (sessionId: string, createdAt: Date) =>
      InteractionModel.create({
        profileId: agent.id,
        sessionId,
        source: "api",
        request: {
          model: "gpt-4",
          messages: [],
        } as unknown as InsertInteraction["request"],
        response: {
          id: "r",
          object: "chat.completion" as const,
          created: Date.now(),
          model: "gpt-4",
          choices: [],
        } as unknown as InsertInteraction["response"],
        type: "openai:chatCompletions",
        createdAt,
      });

    const tiedAt = new Date("2026-01-04T00:00:00.000Z");
    await create("straddling-session", new Date("2026-01-01T00:00:00.000Z"));
    await create("straddling-session", tiedAt);
    await create("tied-session-a", tiedAt);
    await create("tied-session-b", tiedAt);
    await create("older-session", new Date("2026-01-02T00:00:00.000Z"));

    const firstResponse = await app.inject({
      method: "GET",
      url: "/api/interactions/sessions?limit=2",
    });
    expect(firstResponse.statusCode).toBe(200);
    const first = firstResponse.json();
    const secondResponse = await app.inject({
      method: "GET",
      url: `/api/interactions/sessions?limit=2&cursor=${encodeURIComponent(first.pagination.nextCursor)}`,
    });
    expect(secondResponse.statusCode).toBe(200);
    const second = secondResponse.json();
    expect(second.pagination).toMatchObject({
      hasNext: false,
      nextCursor: null,
    });

    const sessions = [...first.data, ...second.data].map(
      (row: { sessionId: string }) => row.sessionId,
    );

    expect(sessions).toHaveLength(4);
    expect(new Set(sessions).size).toBe(4);
    expect(
      sessions.filter((sessionId) => sessionId === "straddling-session"),
    ).toHaveLength(1);
  });

  test("legacy offsets and malformed cursors serve the newest session", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({
      organizationId,
      authorId: currentUser.id,
      scope: "org",
    });
    await InteractionModel.create({
      profileId: agent.id,
      sessionId: "newest-session",
      source: "api",
      request: {
        model: "gpt-4",
        messages: [],
      } as unknown as InsertInteraction["request"],
      response: {
        id: "r",
        object: "chat.completion" as const,
        created: Date.now(),
        model: "gpt-4",
        choices: [],
      } as unknown as InsertInteraction["response"],
      type: "openai:chatCompletions",
      createdAt: new Date("2099-01-01T00:00:00.000Z"),
    });

    for (const query of ["offset=999&page=999", "cursor=truncated"] as const) {
      const response = await app.inject({
        method: "GET",
        url: `/api/interactions/sessions?limit=1&${query}`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data[0].sessionId).toBe("newest-session");
    }
  });

  test("derives the newest preview for long sessions and for sessionless interactions", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({
      organizationId,
      authorId: currentUser.id,
      scope: "org",
    });

    const make = (sessionId: string | null, text: string, second: number) =>
      InteractionModel.create({
        profileId: agent.id,
        sessionId,
        source: "api",
        request: {
          model: "gpt-4",
          messages: [{ role: "user", content: text }],
        } as unknown as InsertInteraction["request"],
        response: {
          id: "r",
          object: "chat.completion" as const,
          created: Date.now(),
          model: "gpt-4",
          choices: [],
        } as unknown as InsertInteraction["response"],
        type: "openai:chatCompletions",
        // Explicit distinct timestamps: the per-session window ranks by
        // created_at and defaultNow() can tie within one millisecond.
        createdAt: new Date(2020, 0, 1, 0, 0, second),
      });

    // More interactions than the per-session fetch window (20), so the
    // preview provably comes from a top-N scan that keeps the NEWEST rows —
    // the pre-LATERAL bug class was ranking/sort mistakes across big
    // sessions timing out or picking stale rows.
    for (let i = 0; i < 25; i++) {
      await make("busy-session", `message ${i}`, i);
    }
    const solo = await make(null, "solo message", 30);

    const response = await app.inject({
      method: "GET",
      url: "/api/interactions/sessions?limit=10",
    });
    expect(response.statusCode).toBe(200);
    const rows = response.json().data as Array<{
      sessionId: string | null;
      interactionId: string | null;
      lastUserMessagePreview: string | null;
    }>;

    const busy = rows.find((r) => r.sessionId === "busy-session");
    expect(busy?.lastUserMessagePreview).toBe("message 24");

    // A sessionless interaction is its own "session" and still gets a preview.
    const soloRow = rows.find((r) => r.interactionId === solo.id);
    expect(soloRow?.lastUserMessagePreview).toBe("solo message");
  });

  test("hides an agent-less interaction from a non-agent-admin", async ({
    makeUser,
    makeMember,
  }) => {
    // The suite's default caller is an org admin; this test needs a caller
    // without agent-admin (or log:admin) standing.
    const limited = await makeUser();
    await makeMember(limited.id, organizationId, { role: "member" });
    currentUser = limited;

    const interaction = await InteractionModel.create({
      profileId: null,
      source: "knowledge:embedding",
      request: { model: "text-embedding-3-small", input: ["hello"] },
      response: {
        object: "list",
        data: [],
        model: "text-embedding-3-small",
      } as unknown as InteractionResponse,
      type: "openai:embeddings",
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/interactions/${interaction.id}`,
    });

    expect(response.statusCode).toBe(404);
  });

  test("names the knowledge base connector a KB interaction belongs to", async ({
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
    makeMember,
  }) => {
    // KB interactions carry no agent, so only an agent admin may read them.
    await makeMember(currentUser.id, organizationId, { role: "admin" });
    const kb = await makeKnowledgeBase(organizationId);
    const connector = await makeKnowledgeBaseConnector(kb.id, organizationId, {
      name: "Docs Web Crawler",
    });
    const interaction = await InteractionModel.create({
      profileId: null,
      connectorId: connector.id,
      source: "knowledge:embedding",
      request: { model: "text-embedding-3-small", input: ["hello"] },
      response: {
        object: "list",
        data: [],
        model: "text-embedding-3-small",
      } as unknown as InteractionResponse,
      type: "openai:embeddings",
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/interactions/${interaction.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      connectorId: connector.id,
      connectorName: "Docs Web Crawler",
    });
  });

  test("hides a KB interaction whose connector belongs to another organization", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
    makeMember,
  }) => {
    await makeMember(currentUser.id, organizationId, { role: "admin" });
    const otherOrg = await makeOrganization();
    const otherKb = await makeKnowledgeBase(otherOrg.id);
    const foreignConnector = await makeKnowledgeBaseConnector(
      otherKb.id,
      otherOrg.id,
      { name: "Secret Connector" },
    );
    const interaction = await InteractionModel.create({
      profileId: null,
      connectorId: foreignConnector.id,
      source: "knowledge:embedding",
      request: { model: "text-embedding-3-small", input: ["hello"] },
      response: {
        object: "list",
        data: [],
        model: "text-embedding-3-small",
      } as unknown as InteractionResponse,
      type: "openai:embeddings",
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/interactions/${interaction.id}`,
    });

    // Not merely a nulled name: the payload itself carries the indexed document
    // text, so the row must not cross the tenant boundary at all.
    expect(response.statusCode).toBe(404);
  });

  test("reports a null connector name when the connector has been deleted", async ({
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
    makeMember,
  }) => {
    await makeMember(currentUser.id, organizationId, { role: "admin" });
    const kb = await makeKnowledgeBase(organizationId);
    const connector = await makeKnowledgeBaseConnector(kb.id, organizationId);
    const interaction = await InteractionModel.create({
      profileId: null,
      connectorId: connector.id,
      source: "knowledge:embedding",
      request: { model: "text-embedding-3-small", input: ["hello"] },
      response: {
        object: "list",
        data: [],
        model: "text-embedding-3-small",
      } as unknown as InteractionResponse,
      type: "openai:embeddings",
    });
    await KnowledgeBaseConnectorModel.delete(connector.id);

    const response = await app.inject({
      method: "GET",
      url: `/api/interactions/${interaction.id}`,
    });

    expect(response.statusCode).toBe(200);
    // The id survives the connector so the log still records what produced it.
    expect(response.json()).toMatchObject({
      connectorId: connector.id,
      connectorName: null,
    });
  });

  describe("own-vs-all log visibility (log:read vs log:admin)", () => {
    let limitedUser: User;
    let otherUser: User;
    let agentId: string;
    let ownRowId: string;
    let otherRowId: string;

    const seedRow = (userId: string | null, sessionId: string) =>
      InteractionModel.create({
        profileId: agentId,
        userId,
        sessionId,
        externalAgentId: userId ? `ext-${userId}` : null,
        request: {
          model: "gpt-4",
          messages: [{ role: "user", content: "Hello" }],
        },
        response: {
          id: "r",
          object: "chat.completion",
          choices: [],
        } as unknown as InteractionResponse,
        type: "openai:chatCompletions",
      });

    beforeEach(async ({ makeAgent, makeUser, makeMember, makeCustomRole }) => {
      const agent = await makeAgent({
        organizationId,
        authorId: currentUser.id,
        scope: "org",
      });
      agentId = agent.id;

      otherUser = await makeUser();
      limitedUser = await makeUser();
      const readOnlyLogs = await makeCustomRole(organizationId, {
        permission: { log: ["read"], agent: ["read"] },
      });
      await makeMember(limitedUser.id, organizationId, {
        role: readOnlyLogs.role,
      });

      ownRowId = (await seedRow(limitedUser.id, "own-session")).id;
      otherRowId = (await seedRow(otherUser.id, "other-session")).id;
      await seedRow(null, "unattributed-session");
    });

    test("log:read lists only the caller's own rows — a userId filter for someone else is overridden", async () => {
      currentUser = limitedUser;

      const list = await app.inject({
        method: "GET",
        url: "/api/interactions?limit=10&offset=0",
      });
      expect(list.statusCode).toBe(200);
      expect(list.json().pagination.total).toBe(1);
      expect(list.json().data[0].id).toBe(ownRowId);

      // Asking for another user's rows must not widen the view.
      const forced = await app.inject({
        method: "GET",
        url: `/api/interactions?limit=10&offset=0&userId=${otherUser.id}`,
      });
      expect(forced.json().pagination.total).toBe(1);
      expect(forced.json().data[0].id).toBe(ownRowId);
    });

    test("log:read hides another user's (and unattributed) detail rows as 404", async () => {
      currentUser = limitedUser;

      const own = await app.inject({
        method: "GET",
        url: `/api/interactions/${ownRowId}`,
      });
      expect(own.statusCode).toBe(200);

      const other = await app.inject({
        method: "GET",
        url: `/api/interactions/${otherRowId}`,
      });
      expect(other.statusCode).toBe(404);
    });

    test("log:read narrows sessions, user-ids, and external-agent-ids to the caller", async () => {
      currentUser = limitedUser;

      const sessions = await app.inject({
        method: "GET",
        url: "/api/interactions/sessions?limit=10",
      });
      expect(sessions.statusCode).toBe(200);
      expect(sessions.json().data).toHaveLength(1);
      expect(sessions.json().data[0].sessionId).toBe("own-session");

      const userIds = await app.inject({
        method: "GET",
        url: "/api/interactions/user-ids",
      });
      expect(userIds.json()).toEqual([
        { id: limitedUser.id, name: limitedUser.name },
      ]);

      const extIds = await app.inject({
        method: "GET",
        url: "/api/interactions/external-agent-ids",
      });
      expect(extIds.json().map((e: { id: string }) => e.id)).toEqual([
        `ext-${limitedUser.id}`,
      ]);
    });

    test("log:admin (custom role) and the predefined admin see every user's rows", async ({
      makeUser,
      makeMember,
      makeCustomRole,
    }) => {
      const auditor = await makeUser();
      const allLogs = await makeCustomRole(organizationId, {
        permission: { log: ["read", "admin"], agent: ["read", "admin"] },
      });
      await makeMember(auditor.id, organizationId, { role: allLogs.role });
      currentUser = auditor;

      const list = await app.inject({
        method: "GET",
        url: "/api/interactions?limit=10&offset=0",
      });
      expect(list.json().pagination.total).toBe(3);

      const other = await app.inject({
        method: "GET",
        url: `/api/interactions/${otherRowId}`,
      });
      expect(other.statusCode).toBe(200);
    });

    test("the predefined platform_admin sees only their own rows", async ({
      makeUser,
      makeMember,
    }) => {
      const platformAdmin = await makeUser();
      await makeMember(platformAdmin.id, organizationId, {
        role: "platform_admin",
      });
      const mine = await seedRow(platformAdmin.id, "pa-session");
      currentUser = platformAdmin;

      const list = await app.inject({
        method: "GET",
        url: "/api/interactions?limit=10&offset=0",
      });
      expect(list.json().pagination.total).toBe(1);
      expect(list.json().data[0].id).toBe(mine.id);

      const other = await app.inject({
        method: "GET",
        url: `/api/interactions/${otherRowId}`,
      });
      expect(other.statusCode).toBe(404);
    });
  });

  describe("session user attribution", () => {
    const seedSession = async (opts: {
      profileId: string;
      sessionId: string;
      userId?: string;
      authMethod: InsertInteraction["authMethod"];
    }) =>
      InteractionModel.create({
        profileId: opts.profileId,
        sessionId: opts.sessionId,
        sessionSource: "claude_metadata",
        type: "anthropic:messages",
        userId: opts.userId,
        authMethod: opts.authMethod,
        request: {
          model: "claude-3-5-sonnet",
          max_tokens: 16,
          messages: [{ role: "user", content: "hi" }],
        } as unknown as InsertInteraction["request"],
        response: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-3-5-sonnet",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        } as unknown as InsertInteraction["response"],
      });

    const fetchSession = async (sessionId: string) => {
      const res = await app.inject({
        method: "GET",
        url: `/api/interactions/sessions?limit=10&sessionId=${sessionId}`,
      });
      expect(res.statusCode).toBe(200);
      return res.json().data[0];
    };

    test("an attributed session exposes user ids and no reason", async ({
      makeAgent,
      makeUser,
    }) => {
      const agent = await makeAgent({
        organizationId,
        authorId: currentUser.id,
        scope: "org",
      });
      const user = await makeUser({ email: "dev@example.com" });
      await seedSession({
        profileId: agent.id,
        sessionId: "attributed-session",
        userId: user.id,
        authMethod: "virtual_key",
      });

      const session = await fetchSession("attributed-session");
      expect(session.userIds).toEqual([user.id]);
      expect(session.unattributedReason).toBeNull();
    });

    test("a shared virtual key reports why the session has no user", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent({
        organizationId,
        authorId: currentUser.id,
        scope: "org",
      });
      // An org-scoped virtual key never sets the interaction's user — only
      // personal ones carry an owner.
      await seedSession({
        profileId: agent.id,
        sessionId: "shared-key-session",
        authMethod: "virtual_key",
      });

      const session = await fetchSession("shared-key-session");
      expect(session.userIds).toEqual([]);
      expect(session.userNames).toEqual([]);
      expect(session.unattributedReason).toBe("shared_virtual_key");
    });

    test("a raw provider key is distinguished from a shared key", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent({
        organizationId,
        authorId: currentUser.id,
        scope: "org",
      });
      await seedSession({
        profileId: agent.id,
        sessionId: "provider-key-session",
        authMethod: "provider_key",
      });

      const session = await fetchSession("provider-key-session");
      expect(session.unattributedReason).toBe("provider_key");
    });
  });

  describe("virtual key identity", () => {
    const seedInteraction = async (opts: {
      profileId: string;
      sessionId?: string;
      userId?: string;
      virtualKeyId?: string;
      passthroughVirtualKeyId?: string;
      authMethod: InsertInteraction["authMethod"];
    }) =>
      InteractionModel.create({
        profileId: opts.profileId,
        sessionId: opts.sessionId,
        sessionSource: opts.sessionId ? "claude_metadata" : undefined,
        type: "anthropic:messages",
        userId: opts.userId,
        virtualKeyId: opts.virtualKeyId,
        passthroughVirtualKeyId: opts.passthroughVirtualKeyId,
        authMethod: opts.authMethod,
        request: {
          model: "claude-3-5-sonnet",
          max_tokens: 16,
          messages: [{ role: "user", content: "hi" }],
        } as unknown as InsertInteraction["request"],
        response: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-3-5-sonnet",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        } as unknown as InsertInteraction["response"],
      });

    const fetchSession = async (sessionId: string) => {
      const res = await app.inject({
        method: "GET",
        url: `/api/interactions/sessions?limit=10&sessionId=${sessionId}`,
      });
      expect(res.statusCode).toBe(200);
      return res.json().data[0];
    };

    test("a session names the shared key it ran on", async ({ makeAgent }) => {
      const agent = await makeAgent({
        organizationId,
        authorId: currentUser.id,
        scope: "org",
      });
      const { virtualKey } = await VirtualApiKeyModel.create({
        organizationId,
        name: "ci-shared",
        scope: "org",
        authorId: currentUser.id,
      });

      await seedInteraction({
        profileId: agent.id,
        sessionId: "shared-key-named",
        virtualKeyId: virtualKey.id,
        authMethod: "virtual_key",
      });

      const session = await fetchSession("shared-key-named");
      expect(session.virtualKeys).toEqual([
        expect.objectContaining({
          id: virtualKey.id,
          name: "ci-shared",
          scope: "org",
          keyType: "standard",
          // A shared key attributes to nobody, even though `currentUser`
          // created it — surfacing the author as the owner would claim an
          // attribution the proxy never makes. The creator is still reported,
          // separately, so the key is not anonymous.
          ownerUserId: null,
          ownerUserName: null,
          teams: [],
          createdByUserName: currentUser.name,
        }),
      ]);
      expect(session.unattributedReason).toBe("shared_virtual_key");
    });

    test("a team-scoped key reports the teams it is shared with", async ({
      makeAgent,
      makeTeam,
    }) => {
      const agent = await makeAgent({
        organizationId,
        authorId: currentUser.id,
        scope: "org",
      });
      const platform = await makeTeam(organizationId, currentUser.id, {
        name: "Platform",
      });
      const security = await makeTeam(organizationId, currentUser.id, {
        name: "Security",
      });
      const { virtualKey } = await VirtualApiKeyModel.create({
        organizationId,
        name: "platform-shared",
        scope: "team",
        authorId: currentUser.id,
        teamIds: [platform.id, security.id],
      });

      await seedInteraction({
        profileId: agent.id,
        sessionId: "team-key-session",
        virtualKeyId: virtualKey.id,
        authMethod: "virtual_key",
      });

      const session = await fetchSession("team-key-session");
      const [key] = session.virtualKeys;
      // Ordered by name so the rendered list is stable between reads.
      expect(key.teams.map((team: { name: string }) => team.name)).toEqual([
        "Platform",
        "Security",
      ]);
      // Still attributes to nobody: shared with a team is not owned by a user.
      expect(key.ownerUserId).toBeNull();
      expect(session.unattributedReason).toBe("shared_virtual_key");
    });

    test("a personal key reports no teams even if rows exist", async ({
      makeAgent,
      makeTeam,
      makeUser,
    }) => {
      const agent = await makeAgent({
        organizationId,
        authorId: currentUser.id,
        scope: "org",
      });
      const owner = await makeUser({ email: "solo@example.com" });
      const team = await makeTeam(organizationId, currentUser.id, {
        name: "Leftover",
      });
      // A key demoted from team to personal scope keeps its junction rows;
      // `teams` describes sharing, so a personal key must report none.
      const { virtualKey } = await VirtualApiKeyModel.create({
        organizationId,
        name: "demoted-key",
        scope: "personal",
        authorId: owner.id,
        teamIds: [team.id],
      });

      await seedInteraction({
        profileId: agent.id,
        sessionId: "demoted-key-session",
        userId: owner.id,
        virtualKeyId: virtualKey.id,
        authMethod: "virtual_key",
      });

      const session = await fetchSession("demoted-key-session");
      expect(session.virtualKeys[0].teams).toEqual([]);
      expect(session.virtualKeys[0].ownerUserId).toBe(owner.id);
    });

    test("a personal key carries the user it stands for", async ({
      makeAgent,
      makeUser,
    }) => {
      const agent = await makeAgent({
        organizationId,
        authorId: currentUser.id,
        scope: "org",
      });
      const owner = await makeUser({
        email: "owner@example.com",
        name: "Key Owner",
      });
      const { virtualKey } = await VirtualApiKeyModel.create({
        organizationId,
        name: "owner-personal",
        scope: "personal",
        authorId: owner.id,
      });

      await seedInteraction({
        profileId: agent.id,
        sessionId: "personal-key-session",
        userId: owner.id,
        virtualKeyId: virtualKey.id,
        authMethod: "virtual_key",
      });

      const session = await fetchSession("personal-key-session");
      expect(session.virtualKeys).toEqual([
        expect.objectContaining({
          name: "owner-personal",
          scope: "personal",
          ownerUserId: owner.id,
          ownerUserName: "Key Owner",
        }),
      ]);
      expect(session.unattributedReason).toBeNull();
    });

    test("both key columns are reported, ordered by name", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent({
        organizationId,
        authorId: currentUser.id,
        scope: "org",
      });
      const { virtualKey: standard } = await VirtualApiKeyModel.create({
        organizationId,
        name: "zzz-provider-credential",
        scope: "org",
      });
      const { virtualKey: passthrough } = await VirtualApiKeyModel.create({
        organizationId,
        name: "aaa-user-identity",
        scope: "personal",
        keyType: "passthrough",
        authorId: currentUser.id,
      });

      await seedInteraction({
        profileId: agent.id,
        sessionId: "both-keys-session",
        userId: currentUser.id,
        virtualKeyId: standard.id,
        passthroughVirtualKeyId: passthrough.id,
        authMethod: "passthrough_virtual_key",
      });

      const session = await fetchSession("both-keys-session");
      expect(
        session.virtualKeys.map((key: { name: string; keyType: string }) => [
          key.name,
          key.keyType,
        ]),
      ).toEqual([
        ["aaa-user-identity", "passthrough"],
        ["zzz-provider-credential", "standard"],
      ]);
    });

    test("a session on no virtual key reports none", async ({ makeAgent }) => {
      const agent = await makeAgent({
        organizationId,
        authorId: currentUser.id,
        scope: "org",
      });
      await seedInteraction({
        profileId: agent.id,
        sessionId: "no-key-session",
        authMethod: "provider_key",
      });

      const session = await fetchSession("no-key-session");
      expect(session.virtualKeys).toEqual([]);
    });

    test("the interaction detail resolves both keys", async ({ makeAgent }) => {
      const agent = await makeAgent({
        organizationId,
        authorId: currentUser.id,
        scope: "org",
      });
      const { virtualKey: standard } = await VirtualApiKeyModel.create({
        organizationId,
        name: "detail-standard",
        scope: "org",
      });
      const { virtualKey: passthrough } = await VirtualApiKeyModel.create({
        organizationId,
        name: "detail-passthrough",
        scope: "personal",
        keyType: "passthrough",
        authorId: currentUser.id,
      });

      const interaction = await seedInteraction({
        profileId: agent.id,
        userId: currentUser.id,
        virtualKeyId: standard.id,
        passthroughVirtualKeyId: passthrough.id,
        authMethod: "passthrough_virtual_key",
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/interactions/${interaction.id}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.virtualKey).toEqual(
        expect.objectContaining({
          id: standard.id,
          name: "detail-standard",
          tokenStart: standard.tokenStart,
          ownerUserId: null,
        }),
      );
      expect(body.passthroughVirtualKey).toEqual(
        expect.objectContaining({
          name: "detail-passthrough",
          keyType: "passthrough",
          ownerUserId: currentUser.id,
        }),
      );
    });

    test("a key from another organization is not resolved", async ({
      makeAgent,
      makeOrganization,
    }) => {
      const agent = await makeAgent({
        organizationId,
        authorId: currentUser.id,
        scope: "org",
      });
      const otherOrg = await makeOrganization();
      const { virtualKey: foreign } = await VirtualApiKeyModel.create({
        organizationId: otherOrg.id,
        name: "other-org-key",
        scope: "org",
      });

      const interaction = await seedInteraction({
        profileId: agent.id,
        userId: currentUser.id,
        virtualKeyId: foreign.id,
        authMethod: "virtual_key",
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/interactions/${interaction.id}`,
      });
      expect(res.statusCode).toBe(200);
      // The id is still on the row, but its name must not cross the tenant
      // boundary.
      expect(res.json().virtualKey).toBeNull();
    });
  });
});
