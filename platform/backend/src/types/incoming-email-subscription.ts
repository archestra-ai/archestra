import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";

export const SelectIncomingEmailSubscriptionSchema = createSelectSchema(
  schema.incomingEmailSubscriptionsTable,
);
export const InsertIncomingEmailSubscriptionSchema = createInsertSchema(
  schema.incomingEmailSubscriptionsTable,
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const UpdateIncomingEmailSubscriptionSchema = createUpdateSchema(
  schema.incomingEmailSubscriptionsTable,
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type SelectIncomingEmailSubscription = z.infer<
  typeof SelectIncomingEmailSubscriptionSchema
>;
export type InsertIncomingEmailSubscription = z.infer<
  typeof InsertIncomingEmailSubscriptionSchema
>;
export type UpdateIncomingEmailSubscription = z.infer<
  typeof UpdateIncomingEmailSubscriptionSchema
>;
