/**
 * Public extension contract for cross-cutting LLM proxy behavior.
 *
 * Plugins run in registration order. A tool-call refusal or hold stops later
 * plugins for that event. Any callback error fails the request closed; abort
 * callbacks then run in reverse registration order for every initialized
 * plugin.
 */

export type LlmProxyRequestContext = {
  requestId: string;
  organizationId: string;
  profileId: string;
  userId?: string;
  provider: string;
  protocol: string;
  model: string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  requestBody: unknown;
  session: {
    id: string;
    parentId?: string;
    binding?: string;
  };
  /**
   * Server-owned, request-local values keyed by plugin id. A plugin may consume
   * only its own value; values never cross the proxy's public boundary.
   */
  resources: Map<string, unknown>;
  signal?: AbortSignal;
};

export type LlmProxyPromptContext = LlmProxyRequestContext & {
  prompt: unknown;
};

export type LlmProxyToolCall = {
  id: string;
  name: string;
  arguments: unknown;
  target?: {
    name: string;
    arguments: unknown;
  };
  isChildSpawn?: boolean;
};

export type LlmProxyToolCallsContext = LlmProxyRequestContext & {
  toolCalls: readonly LlmProxyToolCall[];
  response?: unknown;
};

export type LlmProxyToolCallsOutcome =
  | { decision: "allow"; toolCalls: readonly LlmProxyToolCall[] }
  | { decision: "refuse"; message: string; response?: unknown };

export type LlmProxyToolResult = {
  id: string;
  name?: string;
  content: unknown;
  isError?: boolean;
};

export type LlmProxyToolResultsContext = LlmProxyRequestContext & {
  toolResults: readonly LlmProxyToolResult[];
};

export type LlmProxyToolResultsOutcome = {
  toolResults: readonly LlmProxyToolResult[];
  modelUpdates?: unknown;
};

export type LlmProxyTurnEndContext = LlmProxyRequestContext & {
  response?: unknown;
  resultText?: string;
  error?: unknown;
  awaitClientContinuation?: boolean;
  /** A durable continuation is owned by another proxy component. */
  deferCleanup?: boolean;
  beforeResponseRelease?: () => Promise<void>;
};

export type LlmProxyChildContext = LlmProxyRequestContext & {
  /**
   * A verified child proxy turn, not evidence that a client executed the child.
   * The proxy emits start/end around the observed request/response boundary.
   */
  childSessionId: string;
  binding?: string;
  result?: unknown;
};

export interface LlmProxyPlugin {
  readonly id: string;
  onSessionInit?(context: LlmProxyRequestContext): Promise<void>;
  onPrompt?(context: LlmProxyPromptContext): Promise<void>;
  onToolCalls?(
    context: LlmProxyToolCallsContext,
  ): Promise<LlmProxyToolCallsOutcome | undefined>;
  onToolResults?(
    context: LlmProxyToolResultsContext,
  ): Promise<LlmProxyToolResultsOutcome | undefined>;
  onTurnEnd?(context: LlmProxyTurnEndContext): Promise<void>;
  onChildStart?(context: LlmProxyChildContext): Promise<void>;
  onChildEnd?(context: LlmProxyChildContext): Promise<void>;
  onAbort?(context: LlmProxyRequestContext): Promise<void>;
}

export class LlmProxyPluginError extends Error {
  readonly pluginId: string;
  readonly phase: string;

  constructor(params: { pluginId: string; phase: string; cause: unknown }) {
    super(`LLM proxy plugin ${params.pluginId} failed during ${params.phase}`, {
      cause: params.cause,
    });
    this.name = "LlmProxyPluginError";
    this.pluginId = params.pluginId;
    this.phase = params.phase;
  }
}

/** Minimal ordered registry for the LLM proxy's request lifecycle. */
export class LlmProxyPluginRegistry {
  private readonly plugins: LlmProxyPlugin[] = [];
  private readonly sessions = new Map<string, LlmProxyPlugin[]>();

  register(plugin: LlmProxyPlugin): () => void {
    if (this.plugins.some((candidate) => candidate.id === plugin.id)) {
      throw new Error(`LLM proxy plugin ${plugin.id} is already registered`);
    }
    this.plugins.push(plugin);
    return () => {
      const index = this.plugins.indexOf(plugin);
      if (index >= 0) this.plugins.splice(index, 1);
    };
  }

  async onSessionInit(context: LlmProxyRequestContext): Promise<void> {
    if (this.sessions.has(context.requestId)) {
      throw new Error(
        `LLM proxy session ${context.requestId} is already active`,
      );
    }

    const initialized: LlmProxyPlugin[] = [];
    this.sessions.set(context.requestId, initialized);
    try {
      for (const plugin of this.plugins) {
        await this.invoke(plugin, "onSessionInit", context);
        initialized.push(plugin);
      }
    } catch (error) {
      try {
        await this.abortInitialized(context, initialized);
      } catch {
        // Initialization is the primary failure. Cleanup is best-effort here,
        // but always releases registry state for a later request with this id.
      } finally {
        this.sessions.delete(context.requestId);
      }
      throw error;
    }
  }

  async onPrompt(context: LlmProxyPromptContext): Promise<void> {
    await this.dispatch(context, "onPrompt");
  }

  async onToolCalls(
    context: LlmProxyToolCallsContext,
  ): Promise<LlmProxyToolCallsOutcome> {
    let outcome: LlmProxyToolCallsOutcome = {
      decision: "allow",
      toolCalls: context.toolCalls,
    };
    for (const plugin of this.getSessionPlugins(context)) {
      const result = (await this.invoke(plugin, "onToolCalls", {
        ...context,
        toolCalls: outcome.toolCalls,
      })) as LlmProxyToolCallsOutcome | undefined;
      if (!result) continue;
      outcome = result;
      if (outcome.decision !== "allow") return outcome;
    }
    return outcome;
  }

  async onToolResults(
    context: LlmProxyToolResultsContext,
  ): Promise<LlmProxyToolResultsOutcome> {
    let outcome: LlmProxyToolResultsOutcome = {
      toolResults: context.toolResults,
    };
    for (const plugin of this.getSessionPlugins(context)) {
      const result = (await this.invoke(plugin, "onToolResults", {
        ...context,
        toolResults: outcome.toolResults,
      })) as LlmProxyToolResultsOutcome | undefined;
      if (result) outcome = result;
    }
    return outcome;
  }

  async onTurnEnd(context: LlmProxyTurnEndContext): Promise<void> {
    const plugins = this.getSessionPlugins(context);
    try {
      for (const plugin of plugins) {
        await this.invoke(plugin, "onTurnEnd", context);
      }
    } catch (error) {
      try {
        await this.abortInitialized(context, plugins);
      } catch {
        // Do not obscure the lifecycle callback that already failed.
      }
      throw error;
    } finally {
      this.sessions.delete(context.requestId);
    }
  }

  async onChildStart(context: LlmProxyChildContext): Promise<void> {
    await this.dispatch(context, "onChildStart");
  }

  async onChildEnd(context: LlmProxyChildContext): Promise<void> {
    await this.dispatch(context, "onChildEnd");
  }

  async onAbort(context: LlmProxyRequestContext): Promise<void> {
    const plugins = this.sessions.get(context.requestId);
    if (!plugins) return;
    try {
      await this.abortInitialized(context, plugins);
    } finally {
      this.sessions.delete(context.requestId);
    }
  }

  private async dispatch<
    TContext extends LlmProxyRequestContext,
    TPhase extends "onPrompt" | "onChildStart" | "onChildEnd",
  >(context: TContext, phase: TPhase): Promise<void> {
    for (const plugin of this.getSessionPlugins(context)) {
      await this.invoke(plugin, phase, context);
    }
  }

  private getSessionPlugins(context: LlmProxyRequestContext): LlmProxyPlugin[] {
    const plugins = this.sessions.get(context.requestId);
    if (!plugins) {
      throw new Error(`LLM proxy session ${context.requestId} is not active`);
    }
    return plugins;
  }

  private async abortInitialized(
    context: LlmProxyRequestContext,
    plugins: readonly LlmProxyPlugin[],
  ): Promise<void> {
    let firstError: unknown;
    for (const plugin of [...plugins].reverse()) {
      try {
        await this.invoke(plugin, "onAbort", context);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) throw firstError;
  }

  private async invoke<
    TPhase extends keyof LlmProxyPlugin,
    TContext extends LlmProxyRequestContext,
  >(
    plugin: LlmProxyPlugin,
    phase: TPhase,
    context: TContext,
  ): Promise<unknown> {
    const callback = plugin[phase];
    if (!callback) return undefined;
    try {
      return await (callback as (context: TContext) => Promise<unknown>).call(
        plugin,
        context,
      );
    } catch (cause) {
      throw new LlmProxyPluginError({ pluginId: plugin.id, phase, cause });
    }
  }
}

const defaultLlmProxyPluginRegistry = new LlmProxyPluginRegistry();

/** Registers a plugin for every LLM proxy request in this process. */
export function registerLlmProxyPlugin(plugin: LlmProxyPlugin): () => void {
  return defaultLlmProxyPluginRegistry.register(plugin);
}

/** Returns the proxy's process-wide plugin registry. */
export function getLlmProxyPluginRegistry(): LlmProxyPluginRegistry {
  return defaultLlmProxyPluginRegistry;
}
