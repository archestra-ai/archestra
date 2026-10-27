import { createHash } from "node:crypto";
import { z } from "zod";

const ScoreQuestionSchema = z.object({
  type: z.literal("score"),
  instructions: z.string(),
  criteria: z.array(z.string()).min(2),
});

const NoulQuestionSchema = z.object({
  type: z.literal("noul"),
  instructions: z.string(),
});

const JevQuestionSchema = z.discriminatedUnion("type", [
  ScoreQuestionSchema,
  NoulQuestionSchema,
]);

/** Everything that shapes the scorer's answers; any edit is a new scorer version. */
export const ScorerSpecSchema = z.object({
  name: z.string().min(1),
  model: z.string().min(1),
  questions: z.record(z.string(), JevQuestionSchema),
  /** Bump whenever the state the questions are asked about changes shape or truncation. */
  stateTemplateVersion: z.number().int().positive(),
});
export type ScorerSpec = z.infer<typeof ScorerSpecSchema>;

export function specHash(spec: ScorerSpec): string {
  return createHash("sha256").update(canonicalJson(spec)).digest("hex");
}

/** JSON with object keys sorted recursively; arrays keep their order. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export interface JevSessionSpec extends ScorerSpec {
  questions: {
    tier_needed: z.infer<typeof ScoreQuestionSchema>;
    long_context: z.infer<typeof NoulQuestionSchema>;
  };
}

// Question wording ported verbatim from the router PoC rubric.
export const JEV_SESSION_SPEC: JevSessionSpec = {
  name: "jev-session",
  model: "jev-1.13.0",
  questions: {
    tier_needed: {
      type: "score",
      instructions:
        "What is the least capable kind of AI model that would complete the whole session started by `prompt` " +
        "as well as a frontier model would?",
      criteria: [
        "A small, fast, low-cost model (Haiku-class) would do it as well as a frontier model.",
        "A mid-tier model (Sonnet-class: strong, but below the frontier) is needed; a small model would fall short.",
        "Only a frontier model (Opus-class) would do it well; a mid-tier model would fall short.",
      ],
    },
    long_context: {
      type: "noul",
      instructions:
        "Will the AI agent's working context during the session started by `prompt` grow beyond roughly 100,000 tokens " +
        "(about 75,000 words), for example by reading many large files, long logs, or running a long multi-step task?",
    },
  },
  stateTemplateVersion: 2,
};
