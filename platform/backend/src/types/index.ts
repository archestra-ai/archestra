import type { Tool } from "@shared/vercel-ai/types";
import type { generateText, ModelMessage } from "ai";

export * from "./agent";
export * from "./api";
export * from "./autonomy-policies";
export * from "./dual-llm-config";
export * from "./dual-llm-result";
export * from "./interaction";
export * from "./llm-providers";
export * from "./tool";

export type MagicalType = Pick<
  Parameters<typeof generateText>[0],
  "toolChoice" | "temperature" | "maxOutputTokens"
> & {
  tools: Record<string, Tool>;
  messages: ModelMessage[];
};
