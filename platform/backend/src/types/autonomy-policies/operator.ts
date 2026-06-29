import { z } from "zod";

export const SupportedOperatorSchema = z.enum([
  "equal",
  "notEqual",
  "contains",
  "notContains",
  "startsWith",
  "endsWith",
  "regex",
]);

export type SupportedOperator = z.infer<typeof SupportedOperatorSchema>;
