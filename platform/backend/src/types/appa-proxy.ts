import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const AppaCheckpointBindingStateSchema = z.enum(["bound", "error"]);
export type AppaCheckpointBindingState = z.infer<
  typeof AppaCheckpointBindingStateSchema
>;

export const SelectAppaProxyCheckpointBindingSchema = createSelectSchema(
  schema.appaProxyCheckpointBindingsTable,
  { state: AppaCheckpointBindingStateSchema },
);
export type AppaProxyCheckpointBinding = z.infer<
  typeof SelectAppaProxyCheckpointBindingSchema
>;
