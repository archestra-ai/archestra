import { z } from "zod";

/** Server-owned labels captured when a request is admitted. */
export const AttributionLabelsSchema = z.record(z.string(), z.string());
export type AttributionLabels = z.infer<typeof AttributionLabelsSchema>;
