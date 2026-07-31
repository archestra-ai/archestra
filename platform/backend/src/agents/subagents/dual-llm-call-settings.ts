import {
  ANTHROPIC_THINKING_OFF_HEADER,
  anthropicSupportsThinkingDisabled,
  geminiMinimalThinkingConfig,
  type SupportedProvider,
} from "@archestra/shared";
import type { generateText } from "ai";
import {
  isAzureOpenAiFirstPartyModelName,
  isAzureThinkingModelName,
} from "@/clients/azure-url";
import { isOpenAiCodexCredential } from "@/services/openai-codex-credentials";

/**
 * Output-token ceiling for every dual LLM interrogation call. The visible
 * outputs are tiny (a multiple-choice question, a bare answer index, a
 * paragraph summary); the ceiling exists to bound reasoning-token blowups on
 * models whose reasoning can only be floored, not disabled — reasoning counts
 * against this cap on those APIs, so it stays well above the visible-output
 * need.
 *
 * @public — consumed by tests pinning the cap's wiring
 */
export const DUAL_LLM_MAX_OUTPUT_TOKENS = 2048;

type ProviderOptions = NonNullable<
  Parameters<typeof generateText>[0]["providerOptions"]
>;

export interface DualLlmCallSettings {
  maxOutputTokens: number;
  providerOptions?: ProviderOptions;
  headers?: Record<string, string>;
}

/**
 * Reasoning is pure latency and cost inside the dual LLM workflow — the main
 * agent writes one-line questions and the quarantine agent answers with an
 * option index — so every interrogation call disables it where the provider
 * can, floors it at the minimal supported effort where it can't, and always
 * caps output tokens. Every knob here was verified through all three layers
 * (installed AI-SDK schema → proxy route schema → adapter passthrough); a
 * provider with no reachable or safe knob deliberately gets only the cap.
 */
export function buildDualLlmCallSettings(params: {
  provider: SupportedProvider;
  modelName: string;
  apiKey: string | undefined;
}): DualLlmCallSettings {
  const tuning = providerReasoningTuning[params.provider](params);
  return { maxOutputTokens: DUAL_LLM_MAX_OUTPUT_TOKENS, ...tuning };
}

// =============================================================================
// Internal helpers
// =============================================================================

type ReasoningTuning = Pick<DualLlmCallSettings, "providerOptions" | "headers">;

type TuningBuilder = (params: {
  modelName: string;
  apiKey: string | undefined;
}) => ReasoningTuning;

const noTuning: TuningBuilder = () => ({});

/**
 * One entry per provider; TypeScript enforces the table stays exhaustive when
 * SupportedProvider grows.
 */
const providerReasoningTuning: Record<SupportedProvider, TuningBuilder> = {
  // The AI-SDK swallows `thinking: {type: "disabled"}` (its body builder only
  // serializes enabled/adaptive), so the knob rides a marker header consumed
  // by createAnthropicThinkingDisplayFetch, which writes the disable — or the
  // effort floor on Fable/Mythos-class models — at the HTTP boundary.
  anthropic: () => ({ headers: { [ANTHROPIC_THINKING_OFF_HEADER]: "1" } }),

  openai: ({ modelName, apiKey }) =>
    // The Codex chat translator clamps reasoning to minimal|low|medium|high
    // and coerces "none" (and absence) to "medium" — "minimal" is the floor.
    openAiEffortTuning(
      isOpenAiCodexCredential(apiKey)
        ? "minimal"
        : openAiReasoningEffort(modelName),
    ),

  azure: ({ modelName }) => {
    if (isAzureOpenAiFirstPartyModelName(modelName)) {
      return openAiEffortTuning(openAiReasoningEffort(modelName));
    }
    // Foundry-hosted thinking deployments (deepseek*/mai-ds*): the adapter
    // defaults reasoning_effort to "medium" and never overrides a caller
    // value, so "low" wins. Other deployment names reject the field.
    if (isAzureThinkingModelName(modelName)) {
      return { providerOptions: { azure: { reasoningEffort: "low" } } };
    }
    return {};
  },

  // DeepSeek thinking defaults to enabled on the V4 family; `disabled` is the
  // documented per-request switch.
  deepseek: () => ({
    providerOptions: { deepseek: { thinking: { type: "disabled" } } },
  }),

  // GLM thinking defaults to enabled; glm-4.7 ignores the disable and thinks
  // anyway (compulsory), where the output cap is the only bound.
  zhipuai: () => ({
    providerOptions: { zhipuai: { thinking: { type: "disabled" } } },
  }),

  kimi: ({ modelName }) =>
    modelName.toLowerCase().includes("kimi-k3")
      ? // k3 always reasons; effort low is its floor.
        { providerOptions: { kimi: { reasoningEffort: "low" } } }
      : { providerOptions: { kimi: { thinking: { type: "disabled" } } } },

  // MiniMax M3 accepts the disable; M2.x cannot disable and the parameter
  // rejection falls back to a bare retry.
  minimax: () => ({
    providerOptions: { minimax: { thinking: { type: "disabled" } } },
  }),

  gemini: ({ modelName }) => {
    const thinkingConfig = geminiMinimalThinkingConfig(modelName);
    return thinkingConfig === null
      ? {}
      : { providerOptions: { google: { thinkingConfig } } };
  },

  xai: ({ modelName }) =>
    // Only grok-3-mini supports reasoning_effort; grok-4-class always reasons
    // and 400s on the field, grok-3 (non-mini) doesn't reason.
    modelName.toLowerCase().includes("grok-3-mini")
      ? { providerOptions: { xai: { reasoningEffort: "low" } } }
      : {},

  groq: ({ modelName }) => {
    const id = modelName.toLowerCase();
    if (id.includes("qwen")) {
      return { providerOptions: { groq: { reasoningEffort: "none" } } };
    }
    if (id.includes("gpt-oss")) {
      // gpt-oss has no off switch; low is its floor.
      return { providerOptions: { groq: { reasoningEffort: "low" } } };
    }
    return {};
  },

  cerebras: ({ modelName }) =>
    modelName.toLowerCase().includes("gpt-oss")
      ? { providerOptions: { cerebras: { reasoningEffort: "low" } } }
      : {},

  // OpenRouter's unified reasoning parameter; upstreams with mandatory
  // reasoning ignore or reject it (rejection falls back to a bare retry).
  openrouter: () => ({
    providerOptions: { openrouter: { reasoning: { enabled: false } } },
  }),

  // Per-request switch for Qwen3-style chat templates; templates without the
  // kwarg ignore it.
  vllm: () => ({
    providerOptions: {
      vllm: { chat_template_kwargs: { enable_thinking: false } },
    },
  }),

  // Copilot serves OpenAI ids next to claude-*/gemini-* ids that would 400
  // on reasoning_effort; the ladder returns undefined for those.
  "github-copilot": ({ modelName }) =>
    openAiEffortTuning(openAiReasoningEffort(modelName)),

  bedrock: ({ modelName }) => {
    const id = modelName.toLowerCase();
    // Only Anthropic models take a thinking field; other families reject the
    // unknown key with a ValidationException.
    if (!id.includes("anthropic") && !id.includes("claude")) {
      return {};
    }
    return anthropicSupportsThinkingDisabled(id)
      ? {
          providerOptions: {
            bedrock: {
              additionalModelRequestFields: {
                thinking: { type: "disabled" },
              },
            },
          },
        }
      : {
          providerOptions: {
            bedrock: { reasoningConfig: { maxReasoningEffort: "low" } },
          },
        };
  },

  // Ollama's OpenAI-compatible /v1 endpoint has no reasoning field at any
  // layer; thinking arrives as reasoning_content, which never reaches the
  // parsed text.
  ollama: noTuning,

  // `think: false` makes qwen3-class models leak their entire chain of
  // thought into `content` — the opposite of what the workflow needs — so the
  // model default stands and the cap rides options.num_predict (the native
  // endpoint discards top-level max_output_tokens).
  "ollama-native": () => ({
    providerOptions: {
      ollama: { options: { num_predict: DUAL_LLM_MAX_OUTPUT_TOKENS } },
    },
  }),

  // sonar defaults are non-reasoning; the reasoning models have no off
  // switch and the Agent API accepts no verified reasoning options.
  perplexity: noTuning,

  // Catalog has no reasoning models and the API exposes no request-side
  // reasoning control.
  mistral: noTuning,

  // Catalog has no reasoning models; the thinking field would also be
  // stripped by the proxy schema.
  cohere: noTuning,

  // The upstream Archestra instance's chat schema strips every reasoning
  // knob; only model choice and max_tokens reach it.
  archestra: noTuning,

  // The Graph Chat API carries only message text — no reasoning or token
  // parameters exist on that surface.
  "microsoft-365-copilot": noTuning,
};

function openAiEffortTuning(effort: string | undefined): ReasoningTuning {
  return effort === undefined
    ? {}
    : { providerOptions: { openai: { reasoningEffort: effort } } };
}

/**
 * Per-model OpenAI effort ladder: "none" is a true disable on the gpt-5.1+
 * generations that accept it, "minimal" the gpt-5 floor, "low" the o-series
 * floor. Undefined means send nothing — non-reasoning models 400 on the
 * field (the chat transport emits it unconditionally), and gpt-5-pro accepts
 * only "high".
 */
function openAiReasoningEffort(modelName: string): string | undefined {
  const id = modelName.toLowerCase();
  if (id.includes("gpt-5-pro")) {
    return undefined;
  }
  if (id.includes("o1-pro") || id.includes("o3-pro")) {
    return "low";
  }
  if (/gpt-5\.\d/.test(id)) {
    return "none";
  }
  if (id.includes("gpt-5-chat")) {
    return undefined;
  }
  if (id.startsWith("gpt-5")) {
    return "minimal";
  }
  if (/^(o1|o3|o4-mini)/.test(id)) {
    return "low";
  }
  return undefined;
}
