import { createSelectSchema } from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";

export const SelectA2ATaskEventSchema = createSelectSchema(
  schema.a2aTaskEventsTable,
);

export type A2ATaskEvent = z.infer<typeof SelectA2ATaskEventSchema>;
