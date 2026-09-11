/**
 * Extensible abstract lifecycle hook contracts for the appa-plugin-archestra package.
 * Inspired by Google ADK and Claude Code lifecycle hook patterns.
 */

export type AppaProtocol = "anthropic" | "responses" | "chat_completions";

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
  claimedCall?: {
    name: string;
    rawArguments: Record<string, unknown>;
  };
};

export type AppaSessionIdentity = {
  clientSessionId?: string;
  parentSessionId?: string;
  threadId?: string;
  spawnBinding?: string;
};

export type AppaSessionInitContext = {
  protocol: AppaProtocol;
  clientApp?: string;
  headers: Record<string, string | string[] | undefined>;
  requestBody: unknown;
  organizationId: string;
  userId: string;
  profileId: string;
  model: string;
  provider: string;
};

export type AppaPromptContext = {
  requestBody: unknown;
  promptText?: string;
};

export type AppaToolCallsContext = {
  toolCalls: AppaToolCall[];
  rawResponse?: unknown;
};

export type AppaToolCallsDecision =
  | {
      decision: "allow";
      calls: Array<AppaToolCall & { dispatchId?: string }>;
    }
  | {
      decision: "refuse";
      message: string;
      refusalResponse?: unknown;
    }
  | {
      decision: "held";
      heldResponse: unknown;
    };

export type AppaToolResultContext = {
  results: AppaToolResult[];
};

export type AppaToolResultOutcome = {
  status: "admitted" | "sanitized" | "quarantined";
  admittedResults: AppaToolResult[];
  modelUpdates?: unknown;
};

export type AppaTurnEndContext = {
  responseBody?: unknown;
  error?: unknown;
};

export type AppaChildContext = {
  childId: string;
  spawnBinding?: string;
  result?: unknown;
};

/**
 * Client-specific adapter interface (e.g. appa-plugin-archestra-claude-code,
 * appa-plugin-archestra-codex, appa-plugin-archestra-opencode).
 * Handles protocol-specific wire translation, SSE streaming, and tool shapes.
 */
export interface AppaClientAdapter {
  readonly id: string;
  readonly protocol: AppaProtocol;

  matches(context: {
    protocol: AppaProtocol;
    headers: Record<string, string | string[] | undefined>;
    requestBody: unknown;
  }): boolean;

  extractSessionIdentity(context: {
    headers: Record<string, string | string[] | undefined>;
    requestBody: unknown;
  }): AppaSessionIdentity;

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

/**
 * Checks whether a tool name matches the standard agent/sub-agent spawn convention.
 */
export function isAppaSpawnTool(toolName: string): boolean {
  return /(^|__|\.)(spawn_agent|Agent|Task|task)$/.test(toolName);
}

/**
 * Pluggable lifecycle hook callbacks interface implemented by the foundational
 * appa-plugin-archestra meta-plugin.
 */
export interface AppaLifecycleHookCallbacks {
  onSessionInit(
    context: AppaSessionInitContext,
  ): Promise<AppaSessionHookInstance | undefined>;
}

export interface AppaSessionHookInstance {
  readonly sessionId: string;
  readonly rootId: string;
  readonly adapter: AppaClientAdapter;

  onPrompt(context: AppaPromptContext): Promise<void>;

  onToolCalls(context: AppaToolCallsContext): Promise<AppaToolCallsDecision>;

  onToolResult(context: AppaToolResultContext): Promise<AppaToolResultOutcome>;

  onTurnEnd(context: AppaTurnEndContext): Promise<void>;

  onChildStart(context: AppaChildContext): Promise<void>;

  onChildEnd(context: AppaChildContext): Promise<void>;

  abort(): Promise<void>;
}
