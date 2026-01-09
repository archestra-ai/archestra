import OpenAi from "../openai";

export const ChatMessageSchema = OpenAi.Messages.MessageParamSchema;
export type ChatMessage = OpenAi.Types.Message;
