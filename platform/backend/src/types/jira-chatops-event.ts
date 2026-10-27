import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const JiraChatOpsEventStateSchema = z.enum([
  "pending",
  "processing",
  "completed",
  "held",
]);
export type JiraChatOpsEventState = z.infer<typeof JiraChatOpsEventStateSchema>;

export const JiraChatOpsDeliveryMethodSchema = z.enum(["create", "replace"]);
export type JiraChatOpsDeliveryMethod = z.infer<
  typeof JiraChatOpsDeliveryMethodSchema
>;

const SelectJiraChatOpsEventSchema = createSelectSchema(
  schema.jiraChatOpsEventsTable,
  { state: JiraChatOpsEventStateSchema },
);
export type JiraChatOpsEvent = z.infer<typeof SelectJiraChatOpsEventSchema>;

const SelectJiraChatOpsDeliverySchema = createSelectSchema(
  schema.jiraChatOpsDeliveriesTable,
  { method: JiraChatOpsDeliveryMethodSchema },
);
export type JiraChatOpsDelivery = z.infer<
  typeof SelectJiraChatOpsDeliverySchema
>;
