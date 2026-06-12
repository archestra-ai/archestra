import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const HookEventSchema = z.enum([
  "session_start",
  "pre_tool_use",
  "post_tool_use",
]);
export type HookEvent = z.infer<typeof HookEventSchema>;

export const HookOutcomeSchema = z.enum([
  "proceeded",
  "blocked",
  "error",
  "timeout",
]);
export type HookOutcome = z.infer<typeof HookOutcomeSchema>;

export const HookFileNameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*\.(py|sh)$/,
    "file name must be a plain file name ending in .py or .sh",
  );

const MAX_REQUIREMENTS = 20;
const MAX_REQUIREMENT_LENGTH = 200;
const MAX_CONTENT_LENGTH = 65_536;
export const HookRequirementsSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(MAX_REQUIREMENT_LENGTH)
      .refine((r) => !/[\r\n\0]/.test(r), "must be a single line"),
  )
  .max(MAX_REQUIREMENTS);

export const SelectHookFileSchema = createSelectSchema(schema.hookFilesTable, {
  event: HookEventSchema,
});

export const InsertHookFileSchema = createInsertSchema(schema.hookFilesTable, {
  event: HookEventSchema,
  fileName: HookFileNameSchema,
  content: z.string().min(1).max(MAX_CONTENT_LENGTH),
  requirements: HookRequirementsSchema.default([]),
}).omit({ id: true, createdAt: true, updatedAt: true });

export const UpdateHookFileSchema = createUpdateSchema(schema.hookFilesTable, {
  event: HookEventSchema.optional(),
  fileName: HookFileNameSchema.optional(),
  content: z.string().min(1).max(MAX_CONTENT_LENGTH).optional(),
  requirements: HookRequirementsSchema.optional(),
}).pick({
  event: true,
  fileName: true,
  content: true,
  requirements: true,
  enabled: true,
});

export type HookFile = z.infer<typeof SelectHookFileSchema>;
export type InsertHookFile = z.infer<typeof InsertHookFileSchema>;
export type UpdateHookFile = z.infer<typeof UpdateHookFileSchema>;
