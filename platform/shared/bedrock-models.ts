/** Verified Converse reasoning dialects. Unknown models must not inherit Nova's dialect. */
export function getBedrockReasoningFamily(
  modelId: string,
): "nova" | "claude-adaptive" | null {
  // Foundation-model IDs and regional/global inference-profile IDs use the
  // same suffix. Opaque application-profile ARNs need model resolution first.
  const id = modelId.replace(/^(?:us|us-gov|eu|apac|jp|au|ca|global)\./, "");
  if (/^amazon\.nova-2-lite-v1(?::\d+)?$/.test(id)) return "nova";
  // AWS's adaptive-thinking model list. Older Claude models require a token
  // budget, and GPT's Converse contract is not the SDK's prefix heuristic.
  if (
    /^anthropic\.claude-(?:opus-4-[678]|sonnet-4-6|(?:opus|sonnet)-5(?:-5)?|haiku-5-5|(?:fable|mythos)-5(?:-1)?)(?:-v\d+(?::\d+)?)?$/.test(
      id,
    )
  ) {
    return "claude-adaptive";
  }
  return null;
}
