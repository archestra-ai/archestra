/**
 * OpenRouter message schemas - OpenAI-compatible
 *
 * OpenRouter uses an OpenAI-compatible API for messages with full tool calling
 * support, plus Anthropic-style `cache_control` prompt-cache breakpoints.
 *
 * @see https://openrouter.ai/docs/api-reference/overview
 * @see https://openrouter.ai/docs/guides/best-practices/prompt-caching
 */
import { z } from "zod";
import {
  AssistantMessageParamSchema,
  ContentPartFileSchema,
  ContentPartImageSchema,
  ContentPartInputAudioSchema,
  ContentPartRefusalSchema,
  ContentPartTextSchema,
  DeveloperMessageParamSchema,
  FunctionMessageParamSchema,
  SystemMessageParamSchema,
  ToolMessageParamSchema,
  UserMessageParamSchema,
} from "../openai/messages";

const CacheControlSchema = z.object({
  type: z.literal("ephemeral"),
  ttl: z.enum(["5m", "1h"]).optional(),
});

// OpenRouter takes breakpoints on text parts. Clients such as
// @ai-sdk/openai-compatible also put them on the message when its content is
// a string; the proxy adapter moves those onto a text part before forwarding.
const cacheControl = { cache_control: CacheControlSchema.optional() };

const TextPartSchema = ContentPartTextSchema.extend(cacheControl);
const TextContentSchema = z.union([z.string(), z.array(TextPartSchema)]);

export const MessageParamSchema = z.union([
  DeveloperMessageParamSchema.extend({
    content: TextContentSchema,
    ...cacheControl,
  }),
  SystemMessageParamSchema.extend({
    content: TextContentSchema,
    ...cacheControl,
  }),
  UserMessageParamSchema.extend({
    content: z.union([
      z.string(),
      z.array(
        z.union([
          TextPartSchema,
          ContentPartImageSchema,
          ContentPartInputAudioSchema,
          ContentPartFileSchema,
        ]),
      ),
    ]),
    ...cacheControl,
  }),
  AssistantMessageParamSchema.extend({
    content: z
      .union([
        z.string(),
        z.array(TextPartSchema),
        z.array(ContentPartRefusalSchema),
      ])
      .nullable()
      .optional(),
    ...cacheControl,
  }),
  ToolMessageParamSchema.extend({
    content: z.union([
      z.string(),
      z.array(z.union([TextPartSchema, ContentPartImageSchema])),
    ]),
    ...cacheControl,
  }),
  FunctionMessageParamSchema,
]);
