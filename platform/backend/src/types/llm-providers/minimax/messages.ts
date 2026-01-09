import OpenAi from "../openai";

export const ChatMessageSchema = OpenAi.Messages.MessageParamSchema;
export const ChatMessageListSchema = OpenAi.Messages.MessageParamSchema.array();

export type ChatMessage = OpenAi.Types.Message;
