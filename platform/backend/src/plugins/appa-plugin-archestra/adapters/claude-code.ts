import type { AppaClientAdapter } from "../types";
import { readHeader } from "../utils";

/** Identifies Claude Code Messages requests and normalizes local tool names. */
export class AppaClaudeCodeAdapter implements AppaClientAdapter {
  readonly id = "claude-code" as const;

  matches(context: Parameters<AppaClientAdapter["matches"]>[0]): boolean {
    const userAgent = (
      readHeader(context.headers, "user-agent") ?? ""
    ).toLowerCase();
    return (
      userAgent.includes("claude-code") ||
      userAgent.includes("claude-cli") ||
      readHeader(context.headers, "x-claude-code-session-id") !== undefined
    );
  }

  normalizeLocalToolName(name: string): string {
    return name.startsWith("mcp/") ||
      name.startsWith("mcp__") ||
      name.startsWith("host/")
      ? name
      : `host/claude-code/${name}`;
  }
}
