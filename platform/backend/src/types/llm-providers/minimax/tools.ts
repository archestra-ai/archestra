import OpenAi from "../openai";

export const ToolSchema = OpenAi.Tools.ToolSchema;
export const ToolChoiceSchema = OpenAi.Tools.ToolChoiceOptionSchema;

export type Tool = z.infer<typeof ToolSchema>;
export type ToolChoice = z.infer<typeof ToolChoiceSchema>;

import { z } from "zod";
