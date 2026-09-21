import type { AppaSessionIdentity } from "@/openappa/wire";
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

  classifyToolName(name: string): "gateway" | "local" {
    return name.startsWith("mcp/") || name.startsWith("mcp__")
      ? "gateway"
      : "local";
  }

  normalizeLocalToolName(name: string): string {
    return name.startsWith("host/") ? name : `host/claude-code/${name}`;
  }

  /**
   * Claude Code stamps its session id on every request: the same id across a
   * resume and a `/compact` continuation, which the runtime's reopen keeps on
   * one root. A fork's fresh id is continued on the parent's root by the
   * trajectory stamps in the history it replays. The
   * `metadata.user_id` session blob every Claude client sends stays in the
   * generic wire fallback.
   */
  extractSessionIdentity(context: {
    headers: Readonly<Record<string, string | string[] | undefined>>;
  }): AppaSessionIdentity | undefined {
    const sessionId = readHeader(context.headers, "x-claude-code-session-id");
    return sessionId
      ? { sessionId, provenance: "claude-code-header" }
      : undefined;
  }
}
