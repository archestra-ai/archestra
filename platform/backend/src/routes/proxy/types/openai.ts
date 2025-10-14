import { z } from "zod";
import { OpenAi, UuidIdSchema } from "@/types";

export const ChatCompletionsHeadersSchema = z.object({
  "x-archestra-chat-id": UuidIdSchema.optional().describe(
    "If specified, interactions will be associated with this chat, otherwise a new chat will be created",
  ),
  "user-agent": z.string().optional().describe("The user agent of the client"),
  authorization: OpenAi.API.ApiKeySchema,
});

type ChatCompletionRequest = z.infer<
  typeof OpenAi.API.ChatCompletionRequestSchema
>;
export type ChatCompletionRequestMessages = ChatCompletionRequest["messages"];
export type ChatCompletionRequestTools = ChatCompletionRequest["tools"];
