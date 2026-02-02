import { z } from "zod";

const SystemMessageParamSchema = z
  .object({
    content: z.string(),
    role: z.enum(["system"]),
  })
  .describe(`https://docs.perplexity.ai/api-reference/chat-completions`);

const UserMessageParamSchema = z
  .object({
    content: z.string(),
    role: z.enum(["user"]),
  })
  .describe(`https://docs.perplexity.ai/api-reference/chat-completions`);

const AssistantMessageParamSchema = z
  .object({
    role: z.enum(["assistant"]),
    content: z.string().nullable().optional(),
  })
  .describe(`https://docs.perplexity.ai/api-reference/chat-completions`);

export const MessageParamSchema = z
  .union([
    SystemMessageParamSchema,
    UserMessageParamSchema,
    AssistantMessageParamSchema,
  ])
  .describe(`https://docs.perplexity.ai/api-reference/chat-completions`);
