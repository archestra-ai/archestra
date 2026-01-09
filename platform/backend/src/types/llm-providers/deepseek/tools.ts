import { OpenAi } from "..";

export type Tool = OpenAi.Tools.Tool;
export const ToolSchema = OpenAi.Tools.ToolSchema;

export type ToolCall = OpenAi.Tools.ToolCall;
export const ToolCallSchema = OpenAi.Tools.ToolCallSchema;

export type Function = OpenAi.Tools.Function;
export const FunctionSchema = OpenAi.Tools.FunctionSchema;
