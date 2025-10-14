import { z } from "zod";
import { Gemini } from "@/types";

export const ChatCompletionsHeadersSchema = z.object({
  "user-agent": z.string().optional().describe("The user agent of the client"),
  "x-goog-api-key": Gemini.API.ApiKeySchema,
});

type GenerateContentRequest = z.infer<
  typeof Gemini.API.GenerateContentRequestSchema
>;
export type GenerateContentRequestContents = GenerateContentRequest["contents"];
export type GenerateContentRequestTools = GenerateContentRequest["tools"];
