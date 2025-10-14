import { z } from "zod";
import { OpenAi } from "@/types";

export const ChatCompletionsHeadersSchema = z.object({
  "user-agent": z.string().optional().describe("The user agent of the client"),
  authorization: OpenAi.API.ApiKeySchema,
});

type ChatCompletionRequest = z.infer<
  typeof OpenAi.API.ChatCompletionRequestSchema
>;
export type ChatCompletionRequestMessages = ChatCompletionRequest["messages"];
export type ChatCompletionRequestTools = ChatCompletionRequest["tools"];
