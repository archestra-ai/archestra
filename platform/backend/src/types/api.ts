import { z } from "zod";

export const UuidIdSchema = z.uuidv4();

export const ErrorResponseSchema = z.object({
  error: z.union([
    z.string(),
    z.object({
      message: z.string(),
      type: z.string(),
    }),
  ]),
});
