/**
 * Jev API schemas
 *
 * Jev is TypeSafe's decision model: a request asks typed questions about a
 * piece of state, and the response answers each one with probabilities. It has
 * no chat or tool-calling surface. OpenRouter serves the same wire format at
 * `/api/alpha/decisions`, adding routing fields (`provider`, `session_id`,
 * `user`, `trace`) the schemas below forward untouched.
 *
 * The schemas stay loose on purpose: the proxy forwards what it validates, so
 * a strict object would strip fields a newer API version adds.
 *
 * @see https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request
 */
import { z } from "zod";
import { ChatCompletionsHeadersSchema } from "../openai/api";

export { ChatCompletionsHeadersSchema as DecisionsHeadersSchema };

const QuestionTextSchema = z.union([
  z.string(),
  z.record(z.string(), z.unknown()),
  z.array(z.unknown()),
]);

const QuestionSchema = z
  .object({
    type: z.string().describe("Question kind: noul, choice, or score"),
    instructions: QuestionTextSchema,
    criteria: z.unknown(),
  })
  .passthrough();

export const DecisionsRequestSchema = z
  .object({
    model: z.string(),
    state: z
      .union([
        z.string(),
        z.record(z.string(), z.unknown()),
        z.array(z.unknown()),
      ])
      .describe("The content the questions are about"),
    questions: z
      .record(z.string(), QuestionSchema)
      .describe("Decision questions keyed by name"),
  })
  .passthrough();

const DecisionsUsageSchema = z
  .object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    cost: z.number().optional(),
  })
  .passthrough();

export const DecisionsResponseSchema = z
  .object({
    id: z.string().optional(),
    model: z.string().optional(),
    answers: z.record(z.string(), z.unknown()),
    usage: DecisionsUsageSchema.optional(),
  })
  .passthrough();
