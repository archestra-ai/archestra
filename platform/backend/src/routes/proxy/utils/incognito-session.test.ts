// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
/**
 * Contract under test — the LLM-proxy side of incognito chats:
 * - isIncognitoChatSession is true ONLY for the in-app chat's own loopback
 *   proxy call (source "chat" + loopback IP + session id naming an incognito
 *   conversation OWNED by the requesting user); dropping any one signal
 *   yields false
 * - a lookup failure fails closed (true, with a warning log) so a genuine
 *   incognito session is never written in plaintext
 * - only positive lookups are cached; negatives are re-derived every time
 * - redactIncognitoInteraction blanks exactly the content-bearing fields and
 *   preserves every usage/cost/model/session metadata field verbatim
 */
import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { cacheManager } from "@/cache-manager";
import logger from "@/logging";
import { ConversationModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type {
  InsertInteraction,
  InteractionRequest,
  InteractionResponse,
} from "@/types";
import {
  INCOGNITO_REDACTED_MARKER,
  isIncognitoChatSession,
  redactIncognitoInteraction,
  // biome-ignore lint/style/noRestrictedImports: dual-licensed code under test
} from "./incognito-session.ee";

// Map-backed fake with real cache semantics (auto-reset between tests), so
// the positive-result caching contract is exercised for real.
vi.mock("@/cache-manager");
// Mocked to assert on the fail-closed warning log.
vi.mock("@/logging");

describe("isIncognitoChatSession", () => {
  let userId: string;
  let incognitoConversationId: string;
  let plainConversationId: string;

  beforeEach(async ({ makeAgent, makeOrganization, makeUser }) => {
    const user = await makeUser();
    userId = user.id;
    const organization = await makeOrganization();
    const agent = await makeAgent({
      organizationId: organization.id,
      authorId: userId,
    });

    const incognito = await ConversationModel.create({
      id: randomUUID(),
      userId,
      organizationId: organization.id,
      agentId: agent.id,
      incognito: true,
      incognitoDekFingerprint: "v1:test-fingerprint",
    });
    incognitoConversationId = incognito.id;

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
    sessionId: incognitoConversationId,
    userId,
  });

  test("true for a chat-source loopback request on the user's own incognito conversation", async () => {
    await expect(isIncognitoChatSession(chatParams())).resolves.toBe(true);
  });

  test("true for the chat backend's internal chat:* subrequests", async () => {
    // A repair/compaction subrequest carries the same conversation content as
    // the turn it serves, so it must be redacted too.
    await expect(
      isIncognitoChatSession({
        ...chatParams(),
        source: "chat:tool_call_repair",
      }),
    ).resolves.toBe(true);
  });

  test("false when the source is not the in-app chat", async () => {
    await expect(
      isIncognitoChatSession({ ...chatParams(), source: "api" }),
    ).resolves.toBe(false);
    await expect(
      isIncognitoChatSession({ ...chatParams(), source: "model_router" }),
    ).resolves.toBe(false);
  });

  test("false when the request did not arrive over loopback", async () => {
    await expect(
      isIncognitoChatSession({ ...chatParams(), requestIp: "203.0.113.7" }),
    ).resolves.toBe(false);
  });

  test("false when the session id is missing", async () => {
    const lookup = vi.spyOn(ConversationModel, "isIncognitoOwnedBy");
    await expect(
      isIncognitoChatSession({ ...chatParams(), sessionId: null }),
    ).resolves.toBe(false);
    await expect(
      isIncognitoChatSession({ ...chatParams(), sessionId: undefined }),
    ).resolves.toBe(false);
    // Short-circuits before any DB work.
    expect(lookup).not.toHaveBeenCalled();
  });

  test("false when the user id is missing", async () => {
    await expect(
      isIncognitoChatSession({ ...chatParams(), userId: undefined }),
    ).resolves.toBe(false);
  });

  test("false when the user does not own the conversation", async () => {
    await expect(
      isIncognitoChatSession({ ...chatParams(), userId: randomUUID() }),
    ).resolves.toBe(false);
  });

  test("false for a non-incognito conversation", async () => {
    await expect(
      isIncognitoChatSession({
        ...chatParams(),
        sessionId: plainConversationId,
      }),
    ).resolves.toBe(false);
  });

  test("fails closed (true) and logs when the DB lookup throws", async () => {
    vi.spyOn(ConversationModel, "isIncognitoOwnedBy").mockRejectedValue(
      new Error("connection reset"),
    );

    await expect(
      isIncognitoChatSession({
        ...chatParams(),
        sessionId: plainConversationId,
      }),
    ).resolves.toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: plainConversationId }),
      expect.stringContaining("failing closed"),
    );
  });

  test("caches a positive result — the second call never re-queries the model", async () => {
    const lookup = vi.spyOn(ConversationModel, "isIncognitoOwnedBy");
    const setSpy = vi.spyOn(cacheManager, "set");

    await expect(isIncognitoChatSession(chatParams())).resolves.toBe(true);
    await expect(isIncognitoChatSession(chatParams())).resolves.toBe(true);

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledTimes(1);
  });

  test("never caches a negative result — each call re-derives it", async () => {
    const lookup = vi.spyOn(ConversationModel, "isIncognitoOwnedBy");

    await expect(
      isIncognitoChatSession({
        ...chatParams(),
        sessionId: plainConversationId,
      }),
    ).resolves.toBe(false);
    await expect(
      isIncognitoChatSession({
        ...chatParams(),
        sessionId: plainConversationId,
      }),
    ).resolves.toBe(false);

    // A cached `false` could mask a race with conversation creation, so both
    // calls must hit the model.
    expect(lookup).toHaveBeenCalledTimes(2);
  });
});

describe("redactIncognitoInteraction", () => {
  test("replaces content fields and preserves usage/cost/model/session metadata verbatim", () => {
    const record = {
      profileId: randomUUID(),
      userId: "user-1",
      sessionId: "conversation-1",
      sessionSource: "chat",
      source: "chat",
      authMethod: "internal",
      billingMode: "metered",
      type: "anthropic",
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
      dualLlmAnalyses: [
        { verdict: "safe", details: "quoted secret content" },
      ] as unknown as InsertInteraction["dualLlmAnalyses"],
      unsafeContextBoundary: {
        messageIndex: 0,
      } as unknown as InsertInteraction["unsafeContextBoundary"],
    } as InsertInteraction;

    const redacted = redactIncognitoInteraction(record);

    expect(redacted).toEqual({
      ...record,
      request: INCOGNITO_REDACTED_MARKER,
      processedRequest: null,
      response: INCOGNITO_REDACTED_MARKER,
      dualLlmAnalyses: null,
      unsafeContextBoundary: null,
    });
    // Nothing content-bearing leaks through the redacted record.
    expect(JSON.stringify(redacted)).not.toContain("secret");
    // The input record is not mutated.
    expect(record.processedRequest).not.toBeNull();
    expect(JSON.stringify(record.response)).toContain("the secret answer");
  });
});
