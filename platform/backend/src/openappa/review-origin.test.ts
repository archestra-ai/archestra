import { afterEach, beforeEach, expect, test } from "vitest";
import config from "@/config";
import type { IncomingChatMessage } from "@/types";
import { unsignedOfferClaims } from "./offer-claims";
import {
  chatOpsReviewOrigin,
  emailReviewOrigin,
  stampReviewOrigin,
  verifyReviewOrigin,
} from "./review-origin";

const originalSecret = config.openappa.offerSigningSecret;
beforeEach(() => {
  config.openappa.offerSigningSecret = "test-review-origin-signing-key-32chars";
});
afterEach(() => {
  config.openappa.offerSigningSecret = originalSecret;
});

const claims = unsignedOfferClaims({
  organizationId: "org",
  sessionId: "session",
  callerId: "user:alice",
  offerId: "offer",
  tool: "send_message",
});

const message: IncomingChatMessage = {
  messageId: "message",
  channelId: "channel",
  workspaceId: "workspace",
  senderId: "alice",
  senderName: "Alice",
  text: "Private incoming text",
  rawText: "Private raw text",
  isThreadReply: false,
  timestamp: new Date("2026-01-01T00:00:00Z"),
  metadata: {
    conversationType: "channel",
    tenantId: "tenant",
    conversationReference: {
      conversation: { id: "channel" },
      serviceUrl: "https://example.test",
    },
    arbitraryPrompt: "This must not be saved in routing",
  },
};

test("routing contains no user text, attachments or arbitrary model metadata", () => {
  const origin = chatOpsReviewOrigin({ provider: "ms-teams", message });
  expect(origin).toBeDefined();
  const serialized = JSON.stringify(origin);
  expect(serialized).not.toContain("Private");
  expect(serialized).not.toContain("arbitraryPrompt");
  expect(serialized).toContain("https://example.test");
});

test("a signed origin survives JSONB-style object key reordering", () => {
  const origin = chatOpsReviewOrigin({ provider: "ms-teams", message });
  if (!origin) throw new Error("Origin missing");
  const stamp = stampReviewOrigin(origin, claims);
  const reserialized = JSON.parse(JSON.stringify(stamp));
  reserialized.origin.message.metadata.conversationReference = {
    serviceUrl: "https://example.test",
    conversation: { id: "channel" },
  };
  expect(verifyReviewOrigin(reserialized, claims)).toEqual(stamp.origin);
});

test("another channel or offer cannot reuse a valid origin signature", () => {
  const origin = chatOpsReviewOrigin({ provider: "slack", message });
  if (!origin) throw new Error("Origin missing");
  const stamp = stampReviewOrigin(origin, claims);
  if (stamp.origin.type !== "chatops") throw new Error("Unexpected origin");
  expect(
    verifyReviewOrigin(
      {
        ...stamp,
        origin: {
          ...stamp.origin,
          message: { ...stamp.origin.message, channelId: "other" },
        },
      },
      claims,
    ),
  ).toBeUndefined();
  for (const altered of [
    { ...claims, caller_id: "user:bob" },
    { ...claims, organization_id: "other-org" },
    { ...claims, session_id: "other-session" },
    { ...claims, offer_id: "other-offer" },
  ])
    expect(verifyReviewOrigin(stamp, altered)).toBeUndefined();
  expect(
    verifyReviewOrigin(
      { ...stamp, signature: `${stamp.signature}junk` },
      claims,
    ),
  ).toBeUndefined();
});

test("email routing keeps the provider message id without copying its body", () => {
  const origin = emailReviewOrigin({
    messageId: "email",
    fromAddress: "alice@example.com",
    toAddress: "agents@example.com",
    subject: "Private subject",
    body: "Private message",
    conversationId: "thread",
    receivedAt: new Date("2026-01-01T00:00:00Z"),
  });
  expect(origin).toMatchObject({
    type: "email",
    messageId: "email",
    conversationId: "thread",
  });
  expect(JSON.stringify(origin)).not.toContain("Private");
});

test("Telegram review routing preserves the verified message and topic identifiers", () => {
  const origin = chatOpsReviewOrigin({
    provider: "telegram",
    message: {
      ...message,
      channelId: "555",
      workspaceId: null,
      senderId: "555",
      metadata: {
        telegramMessageId: 10,
        messageThreadId: 20,
        arbitraryPrompt: "not routing",
      },
    },
  });
  expect(origin).toMatchObject({
    provider: "telegram",
    message: {
      metadata: { telegramMessageId: 10, messageThreadId: 20 },
    },
  });
  expect(JSON.stringify(origin)).not.toContain("arbitraryPrompt");
});
