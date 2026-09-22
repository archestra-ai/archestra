import type { AppaSessionIdentity } from "@/openappa/wire";
import type { AppaClientAdapter, AskUserArguments } from "../types";
import { questionHeader, readHeader } from "../utils";
import { structuredQuestionRuling } from "./native-question-ruling";

/** Identifies Claude Code Messages requests and normalizes local tool names. */
export class AppaClaudeCodeAdapter implements AppaClientAdapter {
  readonly id = "claude-code" as const;
  readonly nativeQuestion = {
    toolName: "AskUserQuestion",
    fromAskUser: (args: AskUserArguments) => ({
      questions: [
        {
          question: args.question,
          // Claude Code's AskUserQuestion tab label is at most 12 characters.
          header: questionHeader(args.header, 12),
          options: args.options.map((option) => ({
            label: option.label,
            description: option.description ?? option.label,
          })),
          multiSelect: args.allowMultiple === true,
        },
      ],
    }),
    rulingFromResult: structuredQuestionRuling,
  };
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
    // Older receipts used this adapter's invalid host decoration. Normalize it
    // back to Claude's native spelling so the Archestra runtime can derive it.
    return name.startsWith("host/claude-code/")
      ? name.slice("host/claude-code/".length)
      : name;
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
