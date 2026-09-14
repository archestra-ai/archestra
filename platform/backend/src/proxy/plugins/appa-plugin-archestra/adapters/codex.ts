import type { AppaClientAdapter } from "../types";
import { readHeader } from "../utils";

/** Identifies Codex Responses requests and normalizes local tool names. */
export class AppaCodexAdapter implements AppaClientAdapter {
  readonly id = "codex" as const;

  matches(context: Parameters<AppaClientAdapter["matches"]>[0]): boolean {
    const userAgent = (
      readHeader(context.headers, "user-agent") ?? ""
    ).toLowerCase();
    const originator = (
      readHeader(context.headers, "originator") ?? ""
    ).toLowerCase();
    return (
      userAgent.includes("codex") ||
      originator.includes("codex") ||
      readHeader(context.headers, "x-codex-turn-metadata") !== undefined
    );
  }

  classifyToolName(name: string): "gateway" | "local" {
    return name.startsWith("mcp:") ? "gateway" : "local";
  }

  normalizeLocalToolName(name: string): string {
    const stripped = name.startsWith("functions.")
      ? name.slice("functions.".length)
      : name;
    return stripped.startsWith("builtin:") || stripped.startsWith("host/")
      ? stripped
      : `builtin:${stripped}`;
  }
}
