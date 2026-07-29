/**
 * MiniMax message schemas - OpenAI-compatible
 *
 * MiniMax uses an OpenAI-compatible API for messages with tool calling support.
 *
 * @see https://platform.minimax.io/docs/api-reference/text-openai-api
 */
import { z } from "zod";

import {
  AssistantMessageParamSchema,
  MessageParamSchema as OpenAIMessageParamSchema,
} from "../openai/messages";

/**
 * Reasoning detail object carrying the model's thinking text
 * (present when reasoning_split=True is used).
 */
export const ReasoningDetailSchema = z.object({
  text: z.string(),
});

/**
 * MiniMax interleaved thinking: the docs recommend passing the assistant's
 * reasoning_details back on subsequent tool-call turns to preserve the
 * reasoning chain, so body validation must let the field through instead of
 * stripping it. Listed before the OpenAI union so assistant messages match
 * this variant first.
 */
const MinimaxAssistantMessageParamSchema = AssistantMessageParamSchema.extend({
  reasoning_details: z.array(ReasoningDetailSchema).optional(),
});

export const MessageParamSchema = z.union([
  MinimaxAssistantMessageParamSchema,
  OpenAIMessageParamSchema,
]);

export { ToolCallSchema } from "../openai/messages";
