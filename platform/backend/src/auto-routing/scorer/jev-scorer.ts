import { z } from "zod";
import config from "@/config";
import { DecisionsResponseSchema } from "@/types/llm-providers/jev/api";
import { resolveProviderApiKey } from "@/utils/llm-api-key-resolution";
import { JEV_SESSION_SPEC, type JevSessionSpec, type ScorerSpec } from "./spec";
import {
  type ScorerContext,
  ScorerError,
  type ScorerInput,
  type ScorerResult,
  type SessionScorer,
} from "./types";

// State template v1 (spec.stateTemplateVersion): ported from the router PoC rubric.
const PROMPT_HEAD = 3000;
const PROMPT_TAIL = 1000;
const SECRET =
  /(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[abp]-[A-Za-z0-9-]{10,}|[Bb][Ee][Aa][Rr][Ee][Rr]\s+[A-Za-z0-9._-]{20,}|[A-Za-z0-9+/=_-]{40,})/g;
/** Jev's probabilities are rounded; anything further from 1 is a broken answer. */
const PROBABILITY_SUM_TOLERANCE = 0.01;

interface DecisionsRequest {
  model: string;
  state: Record<string, string>;
  questions: ScorerSpec["questions"];
}

const SessionAnswersSchema = DecisionsResponseSchema.extend({
  answers: z.object({
    tier_needed: z.object({
      type: z.literal("score"),
      probabilities: z.record(z.string(), z.number().nonnegative()),
    }),
    long_context: z.object({
      type: z.literal("noul"),
      noul: z.number().min(0).max(1),
    }),
  }),
});

export class JevScorer implements SessionScorer {
  readonly spec: JevSessionSpec;

  constructor(spec: JevSessionSpec = JEV_SESSION_SPEC) {
    this.spec = spec;
  }

  async score(input: ScorerInput, ctx: ScorerContext): Promise<ScorerResult> {
    const { apiKey, baseUrl } = await resolveProviderApiKey({
      organizationId: ctx.organizationId,
      provider: "jev",
    });
    if (!apiKey) {
      throw new ScorerError(
        "no_credentials",
        "No Jev API key is configured for the organization",
      );
    }
    const request: DecisionsRequest = {
      model: this.spec.model,
      state: sessionState(input),
      questions: this.spec.questions,
    };
    const timeout = AbortSignal.timeout(config.autoRouting.scorerTimeoutMs);
    const body = await postDecisions({
      url: baseUrl ?? config.llm.jev.baseUrl,
      apiKey: apiKey.replace(/^Bearer\s+/i, ""),
      request,
      signal: timeout,
    }).catch((error: unknown) => {
      throw transportFailure(error, timeout);
    });
    const parsed = SessionAnswersSchema.safeParse(body);
    if (!parsed.success) {
      throw new ScorerError("invalid_response", "Jev answers do not match", {
        cause: parsed.error,
      });
    }
    const { tier_needed, long_context } = parsed.data.answers;
    return {
      tierNeeded: tierDistribution(tier_needed.probabilities),
      pLong: long_context.noul,
      costUsd: parsed.data.usage?.cost ?? null,
    };
  }
}

async function postDecisions(params: {
  url: string;
  apiKey: string;
  request: DecisionsRequest;
  signal: AbortSignal;
}): Promise<unknown> {
  const response = await fetch(params.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${params.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(params.request),
    signal: params.signal,
  });
  if (!response.ok) {
    throw new ScorerError("http", `Jev answered HTTP ${response.status}`, {
      status: response.status,
    });
  }
  return response.json();
}

function transportFailure(error: unknown, timeout: AbortSignal): unknown {
  switch (true) {
    case error instanceof ScorerError:
      return error;
    case timeout.aborted:
      return new ScorerError("timeout", "Jev did not answer in time", {
        cause: error,
      });
    case error instanceof SyntaxError:
      return new ScorerError("invalid_response", "Jev answered non-JSON", {
        cause: error,
      });
    default:
      return new ScorerError("http", "Jev request failed", { cause: error });
  }
}

function tierDistribution(
  probabilities: Record<string, number>,
): [number, number, number] {
  const level = (key: string) => probabilities[key] ?? Number.NaN;
  const [fast, normal, smart] = [level("0"), level("1"), level("2")];
  const sum = fast + normal + smart;
  // NaN (a missing level) fails this comparison too.
  if (!(Math.abs(sum - 1) <= PROBABILITY_SUM_TOLERANCE)) {
    throw new ScorerError(
      "invalid_response",
      "Jev tier_needed probabilities are not a distribution over three levels",
    );
  }
  return [fast / sum, normal / sum, smart / sum];
}

function sessionState(input: ScorerInput): Record<string, string> {
  const kind = sessionKindPhrase(input);
  return {
    prompt: clip(input.firstUserText.replace(SECRET, "<redacted>")),
    ...(kind ? { session_kind: kind } : {}),
  };
}

function sessionKindPhrase(input: ScorerInput): string | undefined {
  switch (input.kind) {
    case "subagent":
      return "a self-contained brief written by an orchestrator agent for a sub-agent";
    case "main":
      return input.client
        ? "a human's first message to an AI coding agent"
        : undefined;
  }
}

function clip(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= PROMPT_HEAD + PROMPT_TAIL) return text;
  const omitted = chars.length - PROMPT_HEAD - PROMPT_TAIL;
  return `${chars.slice(0, PROMPT_HEAD).join("")}\n…[${omitted} chars omitted]…\n${chars.slice(-PROMPT_TAIL).join("")}`;
}
