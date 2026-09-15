import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const AppaProxySessionStateSchema = z.enum([
  "ready",
  "in_turn",
  "quarantined",
]);
export type AppaProxySessionState = z.infer<typeof AppaProxySessionStateSchema>;

export const AppaProxyCallStateSchema = z.enum([
  "authorization_intent",
  "open",
  "result_intent",
  "result_admitted",
  "denied",
]);
export type AppaProxyCallState = z.infer<typeof AppaProxyCallStateSchema>;

export const SelectAppaProxySessionSchema = createSelectSchema(
  schema.appaProxySessionsTable,
  { state: AppaProxySessionStateSchema },
);
export const InsertAppaProxySessionSchema = createInsertSchema(
  schema.appaProxySessionsTable,
  { state: AppaProxySessionStateSchema },
).omit({ id: true, createdAt: true, updatedAt: true });
export const SelectAppaProxyCallSchema = createSelectSchema(
  schema.appaProxyCallsTable,
  { state: AppaProxyCallStateSchema },
);

export type AppaProxySession = z.infer<typeof SelectAppaProxySessionSchema>;
export type AppaProxyCall = z.infer<typeof SelectAppaProxyCallSchema>;
