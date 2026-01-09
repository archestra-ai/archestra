import { z } from "zod";
import OpenAi from "../openai";

export const ToolSchema = OpenAi.Tools.ToolSchema;
export type Tool = z.infer<typeof ToolSchema>;

export const ToolCallSchema = OpenAi.Messages.ToolCallSchema;
export type ToolCall = z.infer<typeof ToolCallSchema>;

// FunctionSchema is not exported by OpenAI tools, referencing inner schema or omitting if not strictly needed.
// Mapping to generic record for now if strictly needed, or omitting.
// export type Function = OpenAi.Tools.Function;
// export const FunctionSchema = OpenAi.Tools.FunctionSchema;

