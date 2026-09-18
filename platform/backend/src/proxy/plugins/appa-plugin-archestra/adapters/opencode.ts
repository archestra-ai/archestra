import type { AppaSessionIdentity } from "@/openappa/wire";
import { ApiError } from "@/types";
import type { AppaClientAdapter } from "../types";
import { readHeader } from "../utils";

/** Identifies OpenCode Chat Completions requests and normalizes local tool names. */
export class AppaOpenCodeAdapter implements AppaClientAdapter {
  readonly id = "opencode" as const;

  matches(context: Parameters<AppaClientAdapter["matches"]>[0]): boolean {
    const userAgent = (
      readHeader(context.headers, "user-agent") ?? ""
    ).toLowerCase();
    const originator = (
      readHeader(context.headers, "originator") ?? ""
    ).toLowerCase();
    return (
      userAgent.includes("opencode") ||
      originator.includes("opencode") ||
      readHeader(context.headers, "x-opencode-session") !== undefined ||
      readHeader(context.headers, "x-session-affinity") !== undefined
    );
  }

  classifyToolName(name: string): "gateway" | "local" {
    return name.startsWith("mcp:") ? "gateway" : "local";
  }

  normalizeLocalToolName(name: string): string {
    return name.startsWith("builtin:") || name.startsWith("host/")
      ? name
      : `builtin:${name}`;
  }

  /**
   * OpenCode stamps its session id on every request: `X-Session-Id` and its
   * `x-session-affinity` repeat toward ordinary providers, `x-opencode-session`
   * toward OpenCode-hosted ones. The id is stable across a resume and across
   * compaction (the summarizer and title generator run inside the session),
   * and `Session.fork` mints a fresh one — so the session id maps directly
   * onto root reopen and fresh-root-on-fork semantics. `x-parent-session-id`
   * marks a `task` child; until the child flow exists it governs as a root of
   * its own. Contradictory session claims are refused rather than resolved by
   * precedence.
   */
  extractSessionIdentity(context: {
    headers: Readonly<Record<string, string | string[] | undefined>>;
  }): AppaSessionIdentity | undefined {
    const sessionId = readHeader(context.headers, "x-session-id");
    const affinity = readHeader(context.headers, "x-session-affinity");
    const hosted = readHeader(context.headers, "x-opencode-session");
    if (sessionId && affinity && sessionId !== affinity) {
      throw new ApiError(
        400,
        "OpenAPPA cannot bind contradictory OpenCode session headers",
      );
    }
    const normal = sessionId ?? affinity;
    if (normal && hosted && normal !== hosted) {
      throw new ApiError(
        400,
        "OpenAPPA cannot bind contradictory OpenCode session headers",
      );
    }
    if (normal) {
      return { sessionId: normal, provenance: "opencode-session-header" };
    }
    return hosted
      ? { sessionId: hosted, provenance: "opencode-hosted-header" }
      : undefined;
  }
}
