import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const DeviceMcpCommandStatusSchema = z.enum([
  "queued",
  "delivered",
  "completed",
  "unknown",
]);
export type DeviceMcpCommandStatus = z.infer<
  typeof DeviceMcpCommandStatusSchema
>;
export const SelectDeviceMcpConnectionSchema = createSelectSchema(
  schema.deviceMcpConnectionsTable,
);
export type DeviceMcpConnection = z.infer<
  typeof SelectDeviceMcpConnectionSchema
>;
