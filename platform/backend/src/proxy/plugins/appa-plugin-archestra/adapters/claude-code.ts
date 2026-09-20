import type { AppaClientAdapter, AskUserArguments } from "../types";
import { questionHeader, readHeader } from "../utils";

/** Identifies Claude Code Messages requests and normalizes local tool names. */
export class AppaClaudeCodeAdapter implements AppaClientAdapter {
  readonly id = "claude-code" as const;
  readonly nativeQuestion = {
    toolName: "AskUserQuestion",
    fromAskUser: (args: AskUserArguments) => ({
      questions: [
        {
          question: args.question,
          header: questionHeader(args.header, 12),
          options: args.options.map((option) => ({
            label: option.label,
            description: option.description ?? option.label,
          })),
          multiSelect: args.allowMultiple === true,
        },
      ],
    }),
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
}
