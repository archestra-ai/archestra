import { z } from "zod";
import type { ModelRouterEndpoint } from "@/routes/proxy/model-router-access";

const TextPartSchema = z.object({
  type: z.enum(["text", "input_text"]),
  text: z.string(),
});

const ContentSchema = z.union([
  z.string(),
  z.array(z.unknown()).transform((parts) =>
    parts
      .flatMap((part) => {
        const parsed = TextPartSchema.safeParse(part);
        return parsed.success ? [parsed.data.text] : [];
      })
      .join("\n"),
  ),
]);

const UserMessageSchema = z.object({
  role: z.literal("user"),
  content: ContentSchema,
});

const MessagesSchema = z.array(z.unknown());

/**
 * Text of the request's first user message, the conversation's opening that
 * the scorer judges. Null when the request carries none.
 */
export function firstUserText(
  endpoint: ModelRouterEndpoint,
  body: unknown,
): string | null {
  const field = z.record(z.string(), z.unknown()).safeParse(body);
  if (!field.success) return null;
  const items =
    endpoint === "chat_completions" ? field.data.messages : field.data.input;
  if (typeof items === "string") return nonEmpty(items);
  const messages = MessagesSchema.safeParse(items);
  if (!messages.success) return null;
  for (const message of messages.data) {
    const user = UserMessageSchema.safeParse(message);
    if (user.success) return nonEmpty(user.data.content);
  }
  return null;
}

function nonEmpty(text: string): string | null {
  return text.trim() ? text : null;
}
