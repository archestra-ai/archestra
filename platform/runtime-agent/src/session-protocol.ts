import { z } from "zod";

export const NativeSessionProviderSchema = z.enum([
  "codex",
  "claude-code",
  "opencode",
  "hermes",
  "openclaw",
]);
export type NativeSessionProvider = z.infer<typeof NativeSessionProviderSchema>;

/** Wire contract shared with the web viewer; no terminal dimensions or escape codes. */
export const SessionControlSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message"),
    text: z.string().trim().min(1).max(100_000),
  }),
  z.object({ type: z.literal("interrupt") }),
  z.object({
    type: z.literal("respond"),
    requestId: z.string(),
    optionId: z.string().optional(),
    answers: z.record(z.string(), z.string()).optional(),
  }),
]);
export type SessionControl = z.infer<typeof SessionControlSchema>;
export type SessionEntry =
  | { id: string; type: "message"; role: "user" | "assistant"; text: string }
  | {
      id: string;
      type: "tool_call";
      name: string;
      input?: string;
      toolCallId: string;
    }
  | {
      id: string;
      type: "tool_result";
      text: string;
      toolCallId: string;
      isError?: boolean;
    };
export interface SessionRequest {
  id: string;
  title: string;
  description?: string;
  options: Array<{ id: string; label: string }>;
  questions?: Array<{ id: string; text: string; options?: string[] }>;
}
export interface SessionSnapshot {
  version: 1;
  provider: string;
  entries: SessionEntry[];
  session: {
    state:
      | "starting"
      | "working"
      | "idle"
      | "input_required"
      | "failed"
      | "stopped";
    requests: SessionRequest[];
    error?: string;
  };
}
