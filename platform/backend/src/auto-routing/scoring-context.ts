import { createHash } from "node:crypto";
import { z } from "zod";
import type { PreRunInput } from "./signals/types";

/** Use the context actually sent on the wire, including when re-scoring history. */
export function scoringContext(
  body: unknown,
  options: { openingOnly?: boolean } = {},
): Pick<PreRunInput, "systemPrompt" | "tools"> {
  const parsed = z.record(z.string(), z.unknown()).safeParse(body);
  if (!parsed.success) return {};
  const request = parsed.data;
  const system = [text(request.system), text(request.instructions)];
  const messages = request.messages ?? request.input;
  if (Array.isArray(messages)) {
    for (const message of messages) {
      // Later instructions describe the continuation, not the conversation's identity.
      if (options.openingOnly && UserMessageSchema.safeParse(message).success)
        break;
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

/** Context identity for clients without session IDs; ignore tool ordering and cache markers. */
export function scoringContextFingerprint(
  context: Pick<PreRunInput, "systemPrompt" | "tools">,
): string | undefined {
  const system = context.systemPrompt ?? "";
  const names = (context.tools ?? []).map((tool) => tool.name).sort();
  if (!system && names.length === 0) return undefined;
  return createHash("sha256")
    .update(JSON.stringify([system, names]))
    .digest("hex");
}

// === Internal ===

const InstructionMessageSchema = z.object({
  role: z.enum(["system", "developer"]),
  content: z.unknown(),
});
const UserMessageSchema = z.object({ role: z.literal("user") });
const TextPartSchema = z.object({
  type: z.enum(["text", "input_text"]),
  text: z.string(),
});
const ToolNameSchema = z.object({ name: z.string() });
const ToolSchema = z.union([
  z.object({ function: ToolNameSchema }).transform((tool) => tool.function),
  z.object({ custom: ToolNameSchema }).transform((tool) => tool.custom),
  ToolNameSchema,
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
