const SUBSCRIPTION_PREAMBLE =
  "You are Claude Code, Anthropic's official CLI for Claude.";

/**
 * Desktop's native health checks and title generation omit the client preamble
 * its CLI-backed inference sends. Anthropic rejects those subscription calls
 * with a 429 even while the same credential works for the CLI-backed task.
 * Call only for Claude Desktop using a Claude subscription credential.
 */
export function withClaudeDesktopSubscriptionPreamble<T>(request: T): T {
  const { system } = request as { system?: unknown };
  const blocks =
    typeof system === "string"
      ? [{ type: "text", text: system }]
      : Array.isArray(system)
        ? system
        : [];

  if (
    blocks.some(
      (block) =>
        block?.type === "text" &&
        typeof block.text === "string" &&
        block.text.startsWith(SUBSCRIPTION_PREAMBLE),
    )
  ) {
    return request;
  }

  return {
    ...request,
    system: [{ type: "text", text: SUBSCRIPTION_PREAMBLE }, ...blocks],
  };
}
