/**
 * Contract under test — the LLM-proxy side of encrypted chats:
 * - a session is recognised ONLY for the in-app chat's own loopback proxy call
 *   (source "chat" + loopback IP + session id naming an encrypted chat
 *   OWNED by the requesting user); dropping any one signal yields "none"
 * - with a key matching the conversation's fingerprint and an escrow record on
 *   the row, the disposition is "encrypt" and carries that key
 * - EVERY way of failing to establish that falls back to "redact", never to a
 *   plaintext write: no key, wrong key, no escrow record, lookup failure
 * - only positive lookups are cached; negatives are re-derived every time
 * - a cache entry that is not the expected shape (e.g. written by an older
 *   build) is re-derived rather than coerced into "not an encrypted chat"
 * - redactEncryptedChatInteraction blanks exactly the content-bearing fields and
 *   preserves every usage/cost/model/session metadata field verbatim
 */
import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { cacheManager } from "@/cache-manager";
import { encryptedChatDekFingerprint } from "@/content-encryption/encrypted-chat";
import logger from "@/logging";
import { ConversationModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type {
  EncryptedChatEscrowBlob,
  InsertInteraction,
  InteractionRequest,
  InteractionResponse,
} from "@/types";
import {
  ENCRYPTED_CHAT_REDACTED_MARKER,
  redactEncryptedChatInteraction,
  resolveEncryptedChatAuditContext,
} from "./encrypted-chat-session";

// Map-backed fake with real cache semantics (auto-reset between tests), so
// the positive-result caching contract is exercised for real.
vi.mock("@/cache-manager");
// Mocked to assert on the fail-closed warning log.
vi.mock("@/logging");

const ESCROW: EncryptedChatEscrowBlob = {
  v: 1,
  alg: "RSA-OAEP-256",
  escrowKeyFingerprint: "deadbeefdeadbeef",
  wrappedDek: Buffer.alloc(256, 7).toString("base64"),
};

describe("resolveEncryptedChatAuditContext", () => {
  let userId: string;
  let encryptedChatConversationId: string;
  let plainConversationId: string;
  let noEscrowConversationId: string;
  let dek: Buffer;

  beforeEach(async ({ makeAgent, makeOrganization, makeUser }) => {
    const user = await makeUser();
    userId = user.id;
    const organization = await makeOrganization();
    const agent = await makeAgent({
      organizationId: organization.id,
      authorId: userId,
    });
    dek = Buffer.alloc(32, 1);

    const encryptedChatId = randomUUID();
    const encryptedChat = await ConversationModel.create({
      id: encryptedChatId,
      userId,
      organizationId: organization.id,
      agentId: agent.id,
      encryptedChat: true,
      encryptedChatDekFingerprint: encryptedChatDekFingerprint(
        encryptedChatId,
        dek,
      ),
      encryptedChatEscrow: ESCROW,
    });
    encryptedChatConversationId = encryptedChat.id;

    // An encrypted chat with no escrow record cannot be written
    // encrypted — nothing could ever open it again.
    const noEscrowId = randomUUID();
    const noEscrow = await ConversationModel.create({
      id: noEscrowId,
      userId,
      organizationId: organization.id,
      agentId: agent.id,
      encryptedChat: true,
      encryptedChatDekFingerprint: encryptedChatDekFingerprint(noEscrowId, dek),
    });
    noEscrowConversationId = noEscrow.id;

    const plain = await ConversationModel.create({
      userId,
      organizationId: organization.id,
      agentId: agent.id,
    });
    plainConversationId = plain.id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const chatParams = () => ({
    source: "chat" as const,
    requestIp: "127.0.0.1",
    sessionId: encryptedChatConversationId,
    userId,
    dek,
  });

  test("encrypts, carrying the presented key, for the user's own encrypted chat", async () => {
    await expect(
      resolveEncryptedChatAuditContext(chatParams()),
    ).resolves.toEqual({
      kind: "encrypt",
      audit: { dek, conversationId: encryptedChatConversationId },
    });
  });

  test("encrypts for the chat backend's internal chat:* subrequests", async () => {
    // A repair subrequest carries the same conversation content as the turn it
    // serves, so it belongs under the same key.
    await expect(
      resolveEncryptedChatAuditContext({
        ...chatParams(),
        source: "chat:tool_call_repair",
      }),
    ).resolves.toMatchObject({ kind: "encrypt" });
  });

  test("redacts when no key is presented — there is nothing to encrypt under", async () => {
    await expect(
      resolveEncryptedChatAuditContext({ ...chatParams(), dek: null }),
    ).resolves.toEqual({ kind: "redact" });
  });

  test("redacts when the presented key does not match the conversation", async () => {
    await expect(
      resolveEncryptedChatAuditContext({
        ...chatParams(),
        dek: Buffer.alloc(32, 9),
      }),
    ).resolves.toEqual({ kind: "redact" });
  });

  test("redacts when the conversation has no escrow record — an unrecoverable write is worse than a gap", async () => {
    await expect(
      resolveEncryptedChatAuditContext({
        ...chatParams(),
        sessionId: noEscrowConversationId,
      }),
    ).resolves.toEqual({ kind: "redact" });
  });

  test("none when the source is not the in-app chat", async () => {
    await expect(
      resolveEncryptedChatAuditContext({ ...chatParams(), source: "api" }),
    ).resolves.toEqual({ kind: "none" });
    await expect(
      resolveEncryptedChatAuditContext({
        ...chatParams(),
        source: "model_router",
      }),
    ).resolves.toEqual({ kind: "none" });
  });

  test("none for every chatops:* source — the chat prefix must not over-match", async () => {
    for (const source of [
      "chatops:slack",
      "chatops:ms-teams",
      "chatops:telegram",
    ] as const) {
      await expect(
        resolveEncryptedChatAuditContext({ ...chatParams(), source }),
      ).resolves.toEqual({ kind: "none" });
    }
  });

  test("none when the request did not arrive over loopback", async () => {
    await expect(
      resolveEncryptedChatAuditContext({
        ...chatParams(),
        requestIp: "203.0.113.7",
      }),
    ).resolves.toEqual({ kind: "none" });
  });

  test("none when the session id is not a conversation UUID, without touching the database", async () => {
    const lookup = vi.spyOn(
      ConversationModel,
      "getEncryptedChatAuditInfoOwnedBy",
    );
    await expect(
      resolveEncryptedChatAuditContext({
        ...chatParams(),
        sessionId: "native-client-session",
      }),
    ).resolves.toEqual({ kind: "none" });
    expect(lookup).not.toHaveBeenCalled();
  });

  test("none when the session id is missing, without touching the database", async () => {
    const lookup = vi.spyOn(
      ConversationModel,
      "getEncryptedChatAuditInfoOwnedBy",
    );
    await expect(
      resolveEncryptedChatAuditContext({ ...chatParams(), sessionId: null }),
    ).resolves.toEqual({ kind: "none" });
    await expect(
      resolveEncryptedChatAuditContext({
        ...chatParams(),
        sessionId: undefined,
      }),
    ).resolves.toEqual({ kind: "none" });
    expect(lookup).not.toHaveBeenCalled();
  });

  test("none when the user id is missing", async () => {
    await expect(
      resolveEncryptedChatAuditContext({ ...chatParams(), userId: undefined }),
    ).resolves.toEqual({ kind: "none" });
  });

  test("none when the user does not own the conversation", async () => {
    await expect(
      resolveEncryptedChatAuditContext({
        ...chatParams(),
        userId: randomUUID(),
      }),
    ).resolves.toEqual({ kind: "none" });
  });

  test("none for a non-encrypted chat", async () => {
    await expect(
      resolveEncryptedChatAuditContext({
        ...chatParams(),
        sessionId: plainConversationId,
      }),
    ).resolves.toEqual({ kind: "none" });
  });

  test("fails closed to redact, and logs, when the DB lookup throws", async () => {
    vi.spyOn(
      ConversationModel,
      "getEncryptedChatAuditInfoOwnedBy",
    ).mockRejectedValue(new Error("connection reset"));

    await expect(
      resolveEncryptedChatAuditContext({
        ...chatParams(),
        sessionId: plainConversationId,
      }),
    ).resolves.toEqual({ kind: "redact" });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: plainConversationId }),
      expect.stringContaining("failing closed"),
    );
  });

  test("caches a positive result — the second call never re-queries the model", async () => {
    const lookup = vi.spyOn(
      ConversationModel,
      "getEncryptedChatAuditInfoOwnedBy",
    );
    const setSpy = vi.spyOn(cacheManager, "set");

    await expect(
      resolveEncryptedChatAuditContext(chatParams()),
    ).resolves.toMatchObject({ kind: "encrypt" });
    await expect(
      resolveEncryptedChatAuditContext(chatParams()),
    ).resolves.toMatchObject({ kind: "encrypt" });

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledTimes(1);
  });

  test("never caches a negative result — each call re-derives it", async () => {
    const lookup = vi.spyOn(
      ConversationModel,
      "getEncryptedChatAuditInfoOwnedBy",
    );

    for (let i = 0; i < 2; i++) {
      await expect(
        resolveEncryptedChatAuditContext({
          ...chatParams(),
          sessionId: plainConversationId,
        }),
      ).resolves.toEqual({ kind: "none" });
    }

    // A cached negative could mask a race with conversation creation, so both
    // calls must hit the model.
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  test("re-derives rather than trusting a cache entry of an unexpected shape", async () => {
    // The cache is Postgres-backed and shared across replicas, so a rolling
    // deploy can hand this build an entry an older one wrote (a bare `true`).
    // Coercing that to "not an encrypted chat" would write the turn in plaintext.
    const lookup = vi.spyOn(
      ConversationModel,
      "getEncryptedChatAuditInfoOwnedBy",
    );
    vi.spyOn(cacheManager, "get").mockResolvedValueOnce(
      true as unknown as never,
    );

    await expect(
      resolveEncryptedChatAuditContext(chatParams()),
    ).resolves.toMatchObject({ kind: "encrypt" });
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});

describe("redactEncryptedChatInteraction", () => {
  test("replaces content fields and preserves usage/cost/model/session metadata verbatim", () => {
    const record = {
      profileId: randomUUID(),
      userId: "user-1",
      sessionId: "conversation-1",
      sessionSource: "chat",
      source: "chat",
      authMethod: "internal",
      billingMode: "metered",
      type: "anthropic:messages",
      model: "claude-sonnet-4-5",
      baselineModel: "claude-sonnet-4-5",
      inputTokens: 120,
      outputTokens: 34,
      cacheReadTokens: 7,
      cost: "0.0012340000",
      baselineCost: "0.0012340000",
      request: {
        messages: [{ role: "user", content: "the secret prompt" }],
      } as unknown as InteractionRequest,
      processedRequest: {
        messages: [{ role: "user", content: "the sanitized secret prompt" }],
      } as unknown as InteractionRequest,
      response: {
        content: [{ type: "text", text: "the secret answer" }],
      } as unknown as InteractionResponse,
    } as InsertInteraction;

    const redacted = redactEncryptedChatInteraction(record);

    expect(redacted).toEqual({
      ...record,
      request: ENCRYPTED_CHAT_REDACTED_MARKER,
      processedRequest: null,
      response: ENCRYPTED_CHAT_REDACTED_MARKER,
    });
    // Nothing content-bearing leaks through the redacted record.
    expect(JSON.stringify(redacted)).not.toContain("secret");
    // The input record is not mutated.
    expect(record.processedRequest).not.toBeNull();
    expect(JSON.stringify(record.response)).toContain("the secret answer");
  });
});
