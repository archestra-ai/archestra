import { z } from "zod";
import config from "@/config";
import type { AutoRoutingScorerState } from "@/types/auto-routing-api";
import { DecisionsResponseSchema } from "@/types/llm-providers/jev/api";
import { resolveProviderApiKey } from "@/utils/llm-api-key-resolution";
import { JEV_SESSION_SPEC, type JevSessionSpec, type ScorerSpec } from "./spec";
import {
  type PreRunInput,
  type PreRunSignalSource,
  type SignalSourceContext,
  SignalSourceError,
} from "./types";

export const JEV_SESSION_SOURCE_ID = "jev-session";

export interface JevSessionReading {
  /** Distribution of the weakest adequate tier: (fast, normal, smart), sums to 1. */
  tierNeeded: [number, number, number];
  /** Probability that the session's context grows past the long-context threshold. */
  pLong: number;
  /** Upstream-reported cost of the scoring call, when the endpoint reports one. */
  costUsd: number | null;
}

// State template v2 (spec.stateTemplateVersion): ported from the router PoC rubric.
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

/** Whether the organization's sessions can be scored: a Jev key resolves for it. */
export async function scorerState(
  organizationId: string,
): Promise<AutoRoutingScorerState> {
  const { apiKey } = await resolveProviderApiKey({
    organizationId,
    provider: "jev",
  });
  return apiKey ? "ready" : "no_jev_key";
}

export class JevSessionSource
  implements PreRunSignalSource<typeof JEV_SESSION_SOURCE_ID, JevSessionReading>
{
  readonly id = JEV_SESSION_SOURCE_ID;
  readonly spec: JevSessionSpec;

  constructor(spec: JevSessionSpec = JEV_SESSION_SPEC) {
    this.spec = spec;
  }

  async read(
    input: PreRunInput,
    ctx: SignalSourceContext,
  ): Promise<JevSessionReading> {
    const { apiKey, baseUrl } = await resolveProviderApiKey({
      organizationId: ctx.organizationId,
      provider: "jev",
    });
    if (!apiKey) {
      throw new SignalSourceError(
        "no_credentials",
        "No Jev API key is configured for the organization",
      );
    }
    const request: DecisionsRequest = {
      model: this.spec.model,
      state: sessionState(input),
      questions: this.spec.questions,
    };
    const timeout = AbortSignal.timeout(
      ctx.timeoutMs ?? config.autoRouting.scorerTimeoutMs,
    );
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
      throw new SignalSourceError(
        "invalid_response",
        "Jev answers do not match",
        {
          cause: parsed.error,
        },
      );
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
    throw new SignalSourceError(
      "http",
      `Jev answered HTTP ${response.status}`,
      {
        status: response.status,
      },
    );
  }
  return response.json();
}

function transportFailure(error: unknown, timeout: AbortSignal): unknown {
  switch (true) {
    case error instanceof SignalSourceError:
      return error;
    case timeout.aborted:
      return new SignalSourceError("timeout", "Jev did not answer in time", {
        cause: error,
      });
    case error instanceof SyntaxError:
      return new SignalSourceError(
        "invalid_response",
        "Jev answered non-JSON",
        {
          cause: error,
        },
      );
    default:
      return new SignalSourceError("http", "Jev request failed", {
        cause: error,
      });
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
    throw new SignalSourceError(
      "invalid_response",
      "Jev tier_needed probabilities are not a distribution over three levels",
    );
  }
  return [fast / sum, normal / sum, smart / sum];
}

function sessionState(input: PreRunInput): Record<string, string> {
  return { prompt: clip(input.firstUserText.replace(SECRET, "<redacted>")) };
}

function clip(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= PROMPT_HEAD + PROMPT_TAIL) return text;
  const omitted = chars.length - PROMPT_HEAD - PROMPT_TAIL;
  return `${chars.slice(0, PROMPT_HEAD).join("")}\n…[${omitted} chars omitted]…\n${chars.slice(-PROMPT_TAIL).join("")}`;
}
