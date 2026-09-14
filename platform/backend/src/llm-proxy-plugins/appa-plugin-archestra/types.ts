/**
 * Extensible abstract lifecycle hook contracts for the appa-plugin-archestra package.
 * Inspired by Google ADK and Claude Code lifecycle hook patterns.
 */

export type AppaProtocol = "anthropic" | "responses" | "chat_completions";

export type AppaNativeClient =
  | "claude-code"
  | "codex-responses-v1"
  | "opencode-kimi"
  | "unknown";

export type AppaToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  raw?: unknown;
  spawn?: boolean;
};

export type AppaToolResult = {
  id: string;
  name?: string;
  content: unknown;
  isError?: boolean;
  status?: "success" | "failure" | "indeterminate";
  message?: string;
  claimedCall?: {
    name: string;
    rawArguments: string;
  };
};

export type AppaSessionIdentity = {
  clientSessionId?: string;
  parentSessionId?: string;
  threadId?: string;
  spawnBinding?: string;
};

export type AppaSessionIdentityResolution =
  | AppaSessionIdentity
  | { error: string }
  | null;

/**
 * Client-specific adapter interface (e.g. appa-plugin-archestra-claude-code,
 * appa-plugin-archestra-codex, appa-plugin-archestra-opencode).
 * Handles protocol-specific wire translation, SSE streaming, and tool shapes.
 */
export interface AppaClientAdapter {
  readonly id: string;
  readonly nativeClient: Exclude<AppaNativeClient, "unknown">;
  readonly protocol: AppaProtocol;

  matches(context: {
    protocol: AppaProtocol;
    provider?: string;
    headers: Record<string, string | string[] | undefined>;
    requestBody: unknown;
  }): boolean;

  resolveSessionIdentity(context: {
    headers: Record<string, string | string[] | undefined>;
    requestBody: unknown;
    sessionId?: string | null;
    sessionSource?: string | null;
  }): AppaSessionIdentityResolution;

  isNativeSpawnTool(toolName: string): boolean;

  unsupportedNativeLifecycleReason(context: {
    headers: Record<string, string | string[] | undefined>;
    requestBody: unknown;
  }): string | null;

  extractCarrierChild(context: {
    headers: Record<string, string | string[] | undefined>;
    requestBody: unknown;
    sessionId: string | null;
  }): {
    parentClientSessionId: string;
    childClientSessionId: string;
    requestThreadId: string;
  } | null;

  nativeControlTarget?(toolName: string): string | undefined;
  readonly usesSpawnCarrier?: boolean;
  carrierSpawnTarget?(targetName: string): string;

  extractToolCalls(responseBody: unknown): AppaToolCall[];

  rewriteToolCalls(
    responseBody: unknown,
    authorizedCalls: AppaToolCall[],
  ): unknown;

  extractToolResults(requestBody: unknown): AppaToolResult[];

  formatToolResult(admittedResult: AppaToolResult): unknown;

  /**
   * Projects a client-local tool name (e.g. "Bash", "exec_command") into
   * the canonical tool identity expected by OpenAPPA runtime policies.
   */
  canonicalizeLocalToolName?(rawName: string): string;
}
