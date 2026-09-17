import { z } from "zod";
import errors from "./agent-runtime-errors.json";

const safeText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) =>
      [...value].every((character) => {
        const code = character.charCodeAt(0);
        return code === 9 || code === 10 || (code >= 32 && code !== 127);
      }),
    );

export const AgentRuntimeErrorSchema = z
  .object({
    code: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9_.-]+$/),
    phase: z.enum([
      "startup",
      "credentials",
      "provider",
      "tool",
      "terminal",
      "protocol",
    ]),
    message: safeText(2000),
    resolution: safeText(1000),
    httpStatus: z.number().int().min(100).max(599).optional(),
  })
  .strict();

export type AgentRuntimeError = z.infer<typeof AgentRuntimeErrorSchema>;

export function agentRuntimeError(
  code: keyof typeof errors,
): AgentRuntimeError {
  return AgentRuntimeErrorSchema.parse({ code, ...errors[code] });
}

export function formatAgentRuntimeError(error: AgentRuntimeError): string {
  return `${error.message}\n\n${error.resolution}`;
}

const envelope = z.object({
  version: z.literal(1),
  eventId: z.string().uuid(),
  taskId: z.string().uuid(),
  attemptId: z.string().uuid(),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  source: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-zA-Z0-9_.:-]+$/),
  observedAt: z.string().datetime(),
});

export const AgentRuntimeEventSchema = z.union([
  envelope
    .extend({
      type: z.literal("agent.status"),
      status: z.enum(["working", "idle", "unknown"]),
      attention: z.enum(["input_required", "auth_required"]).nullable(),
    })
    .strict(),
  envelope
    .extend({ type: z.literal("diagnostic"), error: AgentRuntimeErrorSchema })
    .strict(),
  envelope
    .extend({
      type: z.literal("turn.finished"),
      outcome: z.literal("failed"),
      error: AgentRuntimeErrorSchema,
    })
    .strict(),
  envelope
    .extend({
      type: z.literal("turn.finished"),
      outcome: z.literal("succeeded"),
      resultRef: safeText(256),
    })
    .strict(),
]);

export type AgentRuntimeEvent = z.infer<typeof AgentRuntimeEventSchema>;

export const AgentRuntimeStateSchema = z
  .object({
    version: z.literal(1),
    attemptId: z.string().uuid(),
    sequence: z.number().int().positive(),
    eventId: z.string().uuid(),
    source: z.string().max(80),
    observedAt: z.string().datetime(),
    activity: z.enum(["working", "idle", "unknown"]),
    outcome: z.enum(["failed", "succeeded"]).nullable(),
    diagnostic: AgentRuntimeErrorSchema.nullable(),
  })
  .strict();

export type AgentRuntimeState = z.infer<typeof AgentRuntimeStateSchema>;
