import { z } from "zod";
import type { PreRunInput } from "./signals/types";

/** Use the context actually sent on the wire, including when re-scoring history. */
export function scoringContext(
  body: unknown,
): Pick<PreRunInput, "systemPrompt" | "tools"> {
  const parsed = z.record(z.string(), z.unknown()).safeParse(body);
  if (!parsed.success) return {};
  const request = parsed.data;
  const system = [text(request.system), text(request.instructions)];
  const messages = request.messages ?? request.input;
  if (Array.isArray(messages)) {
    for (const message of messages) {
      const parsed = InstructionMessageSchema.safeParse(message);
      if (parsed.success) system.push(text(parsed.data.content));
    }
  }
  const tools: NonNullable<PreRunInput["tools"]> = [];
  if (Array.isArray(request.tools)) {
    for (const tool of request.tools) {
      const parsed = ToolSchema.safeParse(tool);
      if (parsed.success) tools.push(parsed.data);
    }
  }
  return { systemPrompt: system.filter(Boolean).join("\n\n"), tools };
}

// === Internal ===

const InstructionMessageSchema = z.object({
  role: z.enum(["system", "developer"]),
  content: z.unknown(),
});
const TextPartSchema = z.object({
  type: z.enum(["text", "input_text"]),
  text: z.string(),
});
const FunctionSchema = z.object({
  name: z.string(),
  description: z
    .string()
    .nullish()
    .transform((description) => description ?? undefined),
});
const ToolSchema = z.union([
  z.object({ function: FunctionSchema }).transform((tool) => tool.function),
  z.object({ custom: FunctionSchema }).transform((tool) => tool.custom),
  FunctionSchema,
  // Responses built-in tools have a type but no function name.
  z.object({ type: z.string() }).transform((tool) => ({ name: tool.type })),
]);

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((part) => {
      const parsed = TextPartSchema.safeParse(part);
      return parsed.success ? [parsed.data.text] : [];
    })
    .join("\n");
}
