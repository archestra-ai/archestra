import { createSelectSchema } from "drizzle-zod";
import type { z } from "zod";
import { interactionUserActivityStateTable } from "@/database/schemas/interaction-user-activity";

export type InteractionUserActivityState = z.infer<
  typeof InteractionUserActivityStateSchema
>;

const InteractionUserActivityStateSchema = createSelectSchema(
  interactionUserActivityStateTable,
);
