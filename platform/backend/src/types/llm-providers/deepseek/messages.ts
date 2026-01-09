import { z } from "zod";
import OpenAi from "../openai";

export type Message = z.infer<typeof OpenAi.Messages.MessageParamSchema>;
export const MessageSchema = OpenAi.Messages.MessageParamSchema;

