import { z } from "zod";

/**
 * Where a feedback pin sits. The overlay re-finds the element by `selector`
 * on the `route` pattern (`/chat/[conversationId]`, never a concrete id), and
 * falls back to the document position when the element is gone.
 */
export const DevFeedbackAnchorSchema = z.object({
  /** Next.js route pattern, so a pin shows on every record of that page. */
  route: z.string().min(1).max(512),
  /** Structural CSS selector of the element (no text, no record ids). */
  selector: z.string().max(2048),
  /** Human breadcrumb shown in the popover and in Slack. */
  label: z.string().max(512),
  /** Pin position inside the element's box, 0..1 on each axis. */
  elementX: z.number().min(0).max(1),
  elementY: z.number().min(0).max(1),
  /** Fallback position, 0..1 of the viewport, when the element is gone. */
  viewportX: z.number().min(0).max(1),
  viewportY: z.number().min(0).max(1),
});

export const DevFeedbackCommentSchema = DevFeedbackAnchorSchema.extend({
  /** Slack message ts of the comment; doubles as its id. */
  id: z.string(),
  text: z.string(),
  authorName: z.string(),
  replyCount: z.number(),
  permalink: z.string().nullable(),
  createdAt: z.string(),
  dispatch: z
    .object({
      status: z.enum(["started", "failed"]),
      runId: z.string().nullable(),
      message: z.string().nullable(),
    })
    .optional(),
});

export const DevFeedbackReplySchema = z.object({
  id: z.string(),
  authorName: z.string(),
  text: z.string(),
  createdAt: z.string(),
});

export const CreateDevFeedbackCommentBodySchema =
  DevFeedbackAnchorSchema.extend({
    text: z.string().trim().min(1).max(4000),
    /** The concrete page URL the comment was made on. */
    url: z.string().max(2048),
    /** `1440x900`-style viewport, for reproducing layout issues. */
    viewport: z.string().max(32),
    /** Absent when the commenter declined the screen-share prompt. */
    screenshot: DevFeedbackFileSchema(["image/png", "image/jpeg"]).optional(),
    clip: DevFeedbackFileSchema(["video/mp4", "video/webm"]).optional(),
  });

/** The saved choice of bot and channel. Holds no credential. */
export const DevFeedbackSetupSchema = z.object({
  /** Slack app id of a chatops bot (the main one or an agent's). */
  botId: z.string(),
  channelId: z.string(),
  channelName: z.string(),
  organizationId: z.string().optional(),
  agentId: z.string().uuid().nullable().optional(),
  workspaceId: z.string().optional(),
  bindingId: z.string().uuid().optional(),
  pinnedAgentId: z.string().uuid().optional(),
});

export const DevFeedbackSetupStatusSchema = z.object({
  configured: z.boolean(),
  channelName: z.string().nullable(),
  agentId: z.string().uuid().nullable().optional(),
  agentName: z.string().nullable().optional(),
});

export const DevFeedbackBotSchema = z.object({
  id: z.string(),
  name: z.string(),
});

export const DevFeedbackChannelSchema = z.object({
  id: z.string(),
  name: z.string(),
  isPrivate: z.boolean(),
});

export const SaveDevFeedbackSetupBodySchema = z.object({
  botId: z.string().min(1).max(64),
  channelId: z.string().regex(/^[CG][A-Z0-9]+$/),
  agentId: z.string().uuid().nullable().optional(),
});

export type DevFeedbackAnchor = z.infer<typeof DevFeedbackAnchorSchema>;
export type DevFeedbackSetup = z.infer<typeof DevFeedbackSetupSchema>;
export type DevFeedbackSetupStatus = z.infer<
  typeof DevFeedbackSetupStatusSchema
>;
export type DevFeedbackBot = z.infer<typeof DevFeedbackBotSchema>;
export type DevFeedbackChannel = z.infer<typeof DevFeedbackChannelSchema>;
export type DevFeedbackComment = z.infer<typeof DevFeedbackCommentSchema>;
export type DevFeedbackReply = z.infer<typeof DevFeedbackReplySchema>;
export type CreateDevFeedbackCommentBody = z.infer<
  typeof CreateDevFeedbackCommentBodySchema
>;

// ===

function DevFeedbackFileSchema<const T extends readonly [string, ...string[]]>(
  mimeTypes: T,
) {
  return z.object({
    mimeType: z.enum(mimeTypes),
    /** Base64 without the `data:` prefix. */
    base64: z.string().min(1),
  });
}

/** In-memory handoff after Slack confirms the original report. */
export type DevFeedbackReport = {
  id: string;
  organizationId: string;
  actorUserId: string;
  authorName: string;
  body: CreateDevFeedbackCommentBody;
  target: DevFeedbackSetup;
  rootTs: string;
  permalink: string | null;
  createdAt: Date;
  media: {
    screenshot: "absent" | "uploaded" | "unavailable";
    clip: "absent" | "uploaded" | "unavailable";
  };
};
