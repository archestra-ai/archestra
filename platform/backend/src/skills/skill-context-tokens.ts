import type { SupportedProvider } from "@archestra/shared";
import logger from "@/logging";
import { getTokenizer } from "@/tokenizers";

/**
 * How many tokens a skill activation adds to the model's context.
 *
 * A skill's entire mechanism is injecting its instructions into the context, so
 * this is the one cost figure that belongs to the skill alone — everything else
 * a skill "costs" is the spend of the turns that carried it, which it shares
 * with whatever else was in the context. It is measured here, at injection time,
 * because nothing downstream can recover it: the block lands inside an ordinary
 * user message (slash-command activation) or an ordinary tool result
 * (`load_skill`), and `interactions.input_tokens` is a single number with no
 * per-segment split.
 *
 * The yardstick is the Context Window Visualizer's: the provider tokenizer for
 * the resolved model, so a measurement can be compared against that view rather
 * than being a second, incompatible estimate. It is still an estimate — the
 * provider's exact prompt accounting is not exposed per segment.
 *
 * Returns null rather than throwing or guessing when the block cannot be
 * measured: the activation itself must never fail for want of a metric, and a
 * null reads as "not measured" instead of "cost nothing".
 */
export function measureSkillContextTokens(params: {
  /** The rendered activation block, exactly as it enters the context. */
  block: string;
  /**
   * Provider serving the turn this block is injected into. Absent on activation
   * paths that have no model in hand (`load_skill` over the gateway, subagent
   * dispatch), where the tiktoken default stands in — the two encoders agree on
   * prose and diverge on dense non-prose, so a skill body measured with the
   * wrong one is off by roughly a tenth, not by an order of magnitude.
   */
  provider?: SupportedProvider | null;
  /** Resolved model id, which disambiguates resellers that front several vendors. */
  model?: string | null;
}): number | null {
  const { block, provider, model } = params;
  if (!block) return null;
  try {
    const tokenizer = getTokenizer(
      provider ?? DEFAULT_TOKENIZER_PROVIDER,
      model,
    );
    return tokenizer.countTokens([{ role: "user", content: block }]);
  } catch (error) {
    logger.warn(
      { err: error, provider, model },
      "[Skills] Failed to measure skill activation context tokens",
    );
    return null;
  }
}

/**
 * Stand-in provider when the activation path has no resolved model. `openai`
 * selects the cl100k_base encoder, which is what every provider in the tokenizer
 * map except Anthropic uses.
 */
const DEFAULT_TOKENIZER_PROVIDER: SupportedProvider = "openai";
