import OpenAi from "../openai";

export const MistralToolSchema = OpenAi.Tools.ToolSchema;
export type MistralTool = OpenAi.Types.Model; // Fallback to Model if no specific tool type is needed, or use any
