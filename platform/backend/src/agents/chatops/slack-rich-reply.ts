import { z } from "zod";

export const SLACK_RICH_REPLY_INSTRUCTIONS = `For a rich Slack reply, return ONLY one fenced \`slack-blocks\` JSON object: {"text":"A complete plain-text summary for notifications and screen readers","blocks":[...]}.
Use Slack Block Kit header, section (text and/or fields), divider, image, context, or actions blocks. Actions may contain only URL buttons with plain_text labels and HTTPS urls. Images require HTTPS image_url and alt_text. Do not supply block_id, action_id, value, selects, inputs, approval buttons, or other callbacks. Use at most 48 blocks and 32 KiB of JSON. The fallback text is required (1–3000 characters); include its important information in the visible blocks too. The platform adds the agent footer. Ordinary Markdown replies still work; use rich blocks only when they help.`;

/**
 * Only an explicit, whole-reply envelope opts into rich rendering. Code examples,
 * malformed payloads, and unsupported controls retain the ordinary text path.
 * Never pass arbitrary agent JSON to Slack's message API.
 */
export function parseSlackRichReply(text: string) {
  const match = /^```slack-blocks\r?\n([\s\S]*?)\r?\n```$/.exec(text.trim());
  if (!match || Buffer.byteLength(match[1], "utf8") > 32 * 1024) {
    return null;
  }
  try {
    const parsed = ReplySchema.safeParse(JSON.parse(match[1]));
    if (!parsed.success) return null;
    return {
      text: parsed.data.text,
      blocks: parsed.data.blocks.map((block, blockIndex) =>
        block.type === "actions"
          ? {
              ...block,
              elements: block.elements.map((button, buttonIndex) => ({
                ...button,
                // This namespace cannot select agents or approve tool calls.
                action_id: `agent_rich_link_${blockIndex}_${buttonIndex}`,
              })),
            }
          : block,
      ),
    };
  } catch {
    return null;
  }
}

// === Allowed presentation-only Block Kit subset ===

const HttpsUrlSchema = z
  .string()
  .url()
  .max(3000)
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  });

function plainText(max: number) {
  return z
    .object({
      type: z.literal("plain_text"),
      text: z.string().trim().min(1).max(max),
      emoji: z.boolean().optional(),
    })
    .strict();
}

function textObject(max: number) {
  return z.union([
    plainText(max),
    z
      .object({
        type: z.literal("mrkdwn"),
        text: z.string().trim().min(1).max(max),
        verbatim: z.boolean().optional(),
      })
      .strict(),
  ]);
}

const ImageElementSchema = z
  .object({
    type: z.literal("image"),
    image_url: HttpsUrlSchema,
    alt_text: z.string().trim().min(1).max(2000),
  })
  .strict();

const BlockSchema = z.union([
  z.object({ type: z.literal("header"), text: plainText(150) }).strict(),
  z
    .object({
      type: z.literal("section"),
      text: textObject(3000).optional(),
      fields: z.array(textObject(2000)).min(1).max(10).optional(),
    })
    .strict()
    .refine((block) => block.text !== undefined || block.fields !== undefined),
  z.object({ type: z.literal("divider") }).strict(),
  ImageElementSchema.extend({ title: plainText(2000).optional() }),
  z
    .object({
      type: z.literal("context"),
      elements: z
        .array(z.union([textObject(2000), ImageElementSchema]))
        .min(1)
        .max(10),
    })
    .strict(),
  z
    .object({
      type: z.literal("actions"),
      elements: z
        .array(
          z
            .object({
              type: z.literal("button"),
              text: plainText(75),
              url: HttpsUrlSchema,
              accessibility_label: z.string().trim().min(1).max(75).optional(),
            })
            .strict(),
        )
        .min(1)
        .max(25),
    })
    .strict(),
]);

const ReplySchema = z
  .object({
    text: z.string().trim().min(1).max(3000),
    // Reserve two blocks for the platform's hint and agent attribution.
    blocks: z.array(BlockSchema).min(1).max(48),
  })
  .strict();
