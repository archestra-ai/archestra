import { isNamedTimeZone } from "@archestra/shared/time-zone";
import { z } from "zod";

/**
 * An IANA time zone name, for days bucketed by Postgres `AT TIME ZONE`.
 * Offsets are refused: Postgres reads their sign inverted.
 */
export const NamedTimeZoneSchema = z
  .string()
  .max(64)
  .refine(isNamedTimeZone, "Unknown time zone");
