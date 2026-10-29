/**
 * Desktop's native health checks and title generation omit the client preamble
 * its CLI-backed inference sends. Anthropic rejects those subscription calls
 * with a 429 even while the same credential works for the CLI-backed task.
 * Call only for Claude Desktop using a Claude subscription credential.
 */
export function withClaudeDesktopSubscriptionPreamble<T>(request: T): T {
  const { system, thinking } = request as {
    system?: unknown;
    thinking?: unknown;
  };
  const blocks =
    typeof system === "string"
      ? [{ type: "text", text: system }]
      : Array.isArray(system)
        ? system
        : [];
  const isTitleGeneration = blocks.some(
    (block) =>
      block?.type === "text" &&
      typeof block.text === "string" &&
      block.text.includes(DESKTOP_TITLE_SYSTEM_MARKER),
  );
  const disableThinking = isTitleGeneration && thinking === undefined;

  if (
    blocks.some(
      (block) =>
        block?.type === "text" &&
        typeof block.text === "string" &&
        block.text.startsWith(SUBSCRIPTION_PREAMBLE),
    )
  ) {
    return disableThinking
      ? { ...request, thinking: { type: "disabled" } }
      : request;
  }

  return {
    ...request,
    system: [{ type: "text", text: SUBSCRIPTION_PREAMBLE }, ...blocks],
    ...(disableThinking ? { thinking: { type: "disabled" } } : {}),
  };
}

const SUBSCRIPTION_PREAMBLE =
  "You are Claude Code, Anthropic's official CLI for Claude.";
const DESKTOP_TITLE_SYSTEM_MARKER = "You write short session titles.";
