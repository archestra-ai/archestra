import { z } from "zod";
import { GetChatResponseSchema } from "../database/schema";

export const ChatIdSchema = GetChatResponseSchema.shape.id;

export const ErrorResponseSchema = z.object({
  error: z.union([
    z.string(),
    z.object({
      message: z.string(),
      type: z.string(),
    }),
  ]),
});
