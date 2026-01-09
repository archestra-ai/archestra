import type { z } from "zod";
import OpenAi from "../openai";

export const ToolSchema = OpenAi.Tools.ToolSchema;
export type Tool = z.infer<typeof ToolSchema>;

export const ToolChoiceSchema = OpenAi.Tools.ToolChoiceOptionSchema;
export type ToolChoice = z.infer<typeof ToolChoiceSchema>;
