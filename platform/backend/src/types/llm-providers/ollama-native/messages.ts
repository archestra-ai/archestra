/**
 * Ollama native `/api/chat` message + tool-call wire types.
 *
 * These are the NATIVE Ollama shapes (api/types.go `Message`, `ToolCall`), NOT
 * the OpenAI-compatible ones re-exported under `../ollama/`. Verified against
 * Ollama v0.32.1 source.
 */
import { z } from "zod";

/**
 * Native tool call. `arguments` is an object on the wire (Ollama response), but
 * ollama-ai-provider-v2 serializes assistant-turn tool inputs as a JSON string
 * on the request side, so accept both.
 */
export const ToolCallSchema = z.looseObject({
  id: z.string().optional(),
  type: z.string().optional(),
  function: z.looseObject({
    index: z.number().optional(),
    name: z.string(),
    arguments: z.union([z.string(), z.record(z.string(), z.unknown())]),
  }),
});

export const MessageSchema = z.looseObject({
  // system | user | assistant | tool | developer
  role: z.string(),
  // A string on the wire; ollama-ai-provider-v2 sends `[]` for image-only user
  // turns, so allow an array too.
  content: z.union([z.string(), z.array(z.unknown())]).optional(),
  thinking: z.string().optional(),
  images: z.array(z.string()).optional(),
  tool_calls: z.array(ToolCallSchema).nullable().optional(),
  tool_name: z.string().optional(),
  tool_call_id: z.string().optional(),
});
