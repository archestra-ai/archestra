/**
 * Per-client startup-guard descriptors — the client-specific half of the guard
 * (the shared engine lives in `../startup-guard.ts`). Each descriptor supplies the
 * wrapped binary, the conversational product name shown in prompts, the install
 * locations (from the shared {@link STARTUP_GUARD_INSTALL} record), the
 * non-interactive launch flags to bow out on, and the exact reverse-of-connect
 * disconnect commands the guard runs when a remote is unreachable.
 *
 * Cursor is deliberately absent: it is a GUI IDE with no wrappable terminal
 * launch command, so no startup guard can host a disconnect for it. Its
 * connect currently has no automated reversal at all — the Disconnect panel
 * that once covered it was removed from the connect flow — so undoing a
 * Cursor connect means editing `~/.cursor/mcp.json` by hand.
 */

export { CLAUDE_CODE_GUARD_CLIENT } from "./claude-code";
export { CODEX_GUARD_CLIENT } from "./codex";
export { COPILOT_GUARD_CLIENT } from "./copilot-cli";
export { OPENCODE_GUARD_CLIENT } from "./opencode";
