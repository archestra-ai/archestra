import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const AppaOpaqueHistoryTriggerSchema = z.enum(["automatic", "manual"]);
export type AppaOpaqueHistoryTrigger = z.infer<
  typeof AppaOpaqueHistoryTriggerSchema
>;

export const AppaOpaqueHistoryModeSchema = z.enum([
  "inference",
  "compactv1",
  "compactv2",
]);
export type AppaOpaqueHistoryMode = z.infer<typeof AppaOpaqueHistoryModeSchema>;

export const SelectAppaOpaqueHistoryWindowSchema = createSelectSchema(
  schema.appaProxyHistoryWindowsTable,
);
export const SelectAppaOpaqueHistoryItemSchema = createSelectSchema(
  schema.appaProxyHistoryItemsTable,
);

export type AppaOpaqueHistoryWindow = z.infer<
  typeof SelectAppaOpaqueHistoryWindowSchema
>;
export type AppaOpaqueHistoryItem = z.infer<
  typeof SelectAppaOpaqueHistoryItemSchema
>;

export type AppaOpaqueHistoryScope = {
  sessionId: string;
  ownerScopeHash: string;
  provider: string;
  protocol: string;
  model: string;
};

export type AppaOpaqueHistoryWindowRef = {
  providerWindowId: string;
  frameVersion: number;
  sourceTurnId: string;
};

export type AppaOpaqueHistorySafePresentation = {
  callId: string;
  presentation: string;
};
