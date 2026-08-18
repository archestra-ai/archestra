/**
 * Prometheus metrics for Agent Skills.
 *
 * A skill spends money by injecting its instruction block into the model's
 * context, so the fleet-level signal worth charting is how often that happens
 * and how many tokens it adds:
 *
 *   sum by (activation_type) (increase(skill_activations_total[1d]))
 *   sum(increase(skill_context_tokens_total[1d]))
 *
 * Labelled only by the activation path — a closed set — and deliberately NOT by
 * skill id or name, which are unbounded, user-generated values that would
 * explode series cardinality (the same reason `external_agent_id` is kept off
 * the llm_* metrics). Per-skill figures live in the database and are served by
 * `GET /api/statistics/skills`.
 */

import client from "prom-client";
import logger from "@/logging";

/**
 * How a skill entered the context: a chat slash command, a `load_skill` tool
 * call, or dispatch to the skill's designated agent.
 */
type SkillActivationType = "slash_command" | "load_skill" | "delegation";

let skillActivationsTotal: client.Counter<string>;
let skillContextTokensTotal: client.Counter<string>;

let initialized = false;

export function initializeSkillMetrics(): void {
  if (initialized) return;
  initialized = true;

  skillActivationsTotal = new client.Counter({
    name: "skill_activations_total",
    help: "Total skill activations, by activation path (slash_command, load_skill, delegation)",
    labelNames: ["activation_type"],
  });

  skillContextTokensTotal = new client.Counter({
    name: "skill_context_tokens_total",
    help: "Total tokens skill activation blocks added to model context, by activation path. Counts measured activations only; compare with skill_activations_total for coverage.",
    labelNames: ["activation_type"],
  });

  logger.info("Skill metrics initialized");
}

/**
 * Count one skill activation. `contextTokens` is the measured size of the
 * injected block, or null where the activation path could not measure it —
 * a null adds nothing to the token counter but still counts the activation.
 */
export function reportSkillActivation(params: {
  activationType: SkillActivationType;
  contextTokens: number | null;
}): void {
  if (!skillActivationsTotal) return;
  const { activationType, contextTokens } = params;
  skillActivationsTotal.inc({ activation_type: activationType });
  if (contextTokens && contextTokens > 0) {
    skillContextTokensTotal.inc(
      { activation_type: activationType },
      contextTokens,
    );
  }
}
