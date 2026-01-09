import type { z } from "zod";
import OpenAi from "../openai";

export const MessageSchema = OpenAi.Messages.MessageParamSchema;
export type Message = z.infer<typeof MessageSchema>;
