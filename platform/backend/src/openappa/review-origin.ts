import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import config from "@/config";
import type { IncomingChatMessage, IncomingEmail } from "@/types";
import type { OfferClaims } from "./offer-claims";

export const ReviewOriginSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("chatops"),
    provider: z.enum(["slack", "ms-teams", "telegram"]),
    message: z.object({
      messageId: z.string().min(1),
      channelId: z.string().min(1),
      workspaceId: z.string().nullable(),
      threadId: z.string().optional(),
      senderId: z.string().min(1),
      senderName: z.string(),
      senderEmail: z.email().optional(),
      isThreadReply: z.boolean(),
      timestamp: z.iso.datetime(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
  }),
  z.object({
    type: z.literal("email"),
    provider: z.literal("outlook"),
    messageId: z.string().min(1),
    fromAddress: z.email(),
    toAddress: z.email(),
    conversationId: z.string().optional(),
    receivedAt: z.iso.datetime(),
  }),
]);

export type ReviewOrigin = z.infer<typeof ReviewOriginSchema>;

export function chatOpsReviewOrigin(params: {
  provider: string;
  message: IncomingChatMessage;
}): Extract<ReviewOrigin, { type: "chatops" }> | undefined {
  if (
    params.provider !== "slack" &&
    params.provider !== "ms-teams" &&
    params.provider !== "telegram"
  )
    return;
  const message = params.message;
  return ReviewOriginSchema.options[0].parse({
    type: "chatops",
    provider: params.provider,
    message: {
      messageId: message.messageId,
      channelId: message.channelId,
      workspaceId: message.workspaceId,
      threadId: message.threadId,
      senderId: message.senderId,
      senderName: message.senderName,
      senderEmail: message.senderEmail,
      isThreadReply: message.isThreadReply,
      timestamp: message.timestamp.toISOString(),
      metadata: {
        conversationType: message.metadata?.conversationType,
        tenantId: message.metadata?.tenantId,
        senderAadObjectId: message.metadata?.senderAadObjectId,
        conversationReference: message.metadata?.conversationReference,
        telegramMessageId: message.metadata?.telegramMessageId,
        messageThreadId: message.metadata?.messageThreadId,
      },
    },
  });
}

export function emailReviewOrigin(email: IncomingEmail): ReviewOrigin {
  return ReviewOriginSchema.parse({
    type: "email",
    provider: "outlook",
    messageId: email.messageId,
    fromAddress: email.fromAddress,
    toAddress: email.toAddress,
    conversationId: email.conversationId,
    receivedAt: email.receivedAt.toISOString(),
  });
}

export function reviewChatMessage(
  origin: Extract<ReviewOrigin, { type: "chatops" }>,
): IncomingChatMessage {
  return {
    ...origin.message,
    text: "",
    rawText: "",
    timestamp: new Date(origin.message.timestamp),
  };
}

export function reviewEmailMessage(
  origin: Extract<ReviewOrigin, { type: "email" }>,
): IncomingEmail {
  return {
    ...origin,
    subject: "",
    body: "",
    receivedAt: new Date(origin.receivedAt),
  };
}

/** Bind routing to the verified offer, not to a browser's submitted fields. */
export function stampReviewOrigin(origin: ReviewOrigin, claims: OfferClaims) {
  const parsed: ReviewOrigin = JSON.parse(
    JSON.stringify(ReviewOriginSchema.parse(origin)),
  );
  return { origin: parsed, signature: signature(parsed, claims) };
}

export function verifyReviewOrigin(
  value: unknown,
  claims: OfferClaims,
): ReviewOrigin | undefined {
  const parsed = z
    .object({
      origin: ReviewOriginSchema,
      signature: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .safeParse(value);
  if (!parsed.success) return;
  const expected = Buffer.from(signature(parsed.data.origin, claims), "hex");
  const received = Buffer.from(parsed.data.signature, "hex");
  if (
    received.length !== expected.length ||
    !timingSafeEqual(received, expected)
  )
    return;
  return parsed.data.origin;
}

function signature(origin: ReviewOrigin, claims: OfferClaims): string {
  return createHmac("sha256", config.openappa.offerSigningSecret)
    .update(
      JSON.stringify(
        canonical({
          purpose: "openappa-review-origin-v1",
          organizationId: claims.organization_id,
          sessionId: claims.session_id,
          parentId: claims.parent_id,
          callerId: claims.caller_id,
          offerId: claims.offer_id,
          origin,
        }),
      ),
    )
    .digest("hex");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}
