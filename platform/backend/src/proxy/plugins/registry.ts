/**
 * Public extension contract for cross-cutting LLM proxy behavior.
 *
 * Plugins observe only proxy request/response boundaries. They never imply
 * that a client executed a tool or that the proxy owns a client-side session.
 */
export type LlmProxyRequestContext = {
  requestId: string;
  organizationId: string;
  profileId: string;
  userId?: string;
  provider: string;
  interactionType: string;
  model: string;
  streaming: boolean;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  requestBody: unknown;
  resources: Map<string, unknown>;
};

export type LlmProxyPromptContext = LlmProxyRequestContext & {
  prompt: unknown;
};

export type LlmProxyBeforeModelContext = LlmProxyRequestContext & {
  request: unknown;
};

type LlmProxyToolCall = {
  id: string;
  name: string;
  arguments: string | Record<string, unknown>;
};

export type LlmProxyToolCallsContext = LlmProxyRequestContext & {
  toolCalls: readonly LlmProxyToolCall[];
};

export type LlmProxyToolCallsOutcome =
  | { decision: "allow"; toolCalls: readonly LlmProxyToolCall[] }
  | { decision: "refuse"; message: string };

type LlmProxyToolResult = {
  id: string;
  name: string;
  content: unknown;
  isError: boolean;
};

export type LlmProxyToolResultsContext = LlmProxyRequestContext & {
  toolResults: readonly LlmProxyToolResult[];
};

/** Uses the request adapter's existing provider-wire update path. */
export type LlmProxyToolResultsOutcome = {
  toolResultUpdates: Readonly<Record<string, string>>;
};

export type LlmProxyModelResponseContext = LlmProxyRequestContext & {
  response: unknown;
};

export type LlmProxyCompleteContext = LlmProxyRequestContext & {
  response?: unknown;
};

export type LlmProxyErrorContext = LlmProxyRequestContext & {
  error: unknown;
};

export interface LlmProxyPlugin {
  readonly id: string;
  onSessionInit?(context: LlmProxyRequestContext): Promise<void>;
  onPrompt?(context: LlmProxyPromptContext): Promise<void>;
  onBeforeModel?(context: LlmProxyBeforeModelContext): Promise<void>;
  onToolCalls?(
    context: LlmProxyToolCallsContext,
  ): Promise<LlmProxyToolCallsOutcome | undefined>;
  onToolResults?(
    context: LlmProxyToolResultsContext,
  ): Promise<LlmProxyToolResultsOutcome | undefined>;
  /**
   * Runs before a non-streaming response is released. Streaming responses are
   * observable only after their already-forwarded chunks are assembled.
   */
  onModelResponse?(
    context: LlmProxyModelResponseContext,
  ): Promise<{ response: unknown } | undefined>;
  onComplete?(context: LlmProxyCompleteContext): Promise<void>;
  onError?(context: LlmProxyErrorContext): Promise<void>;
  onCleanup?(context: LlmProxyRequestContext): Promise<void>;
}

class LlmProxyPluginError extends Error {
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

/** Ordered, fail-closed lifecycle registry for proxy extensions. */
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
        `LLM proxy request ${context.requestId} is already active`,
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
      await this.cleanup(context, initialized);
      this.sessions.delete(context.requestId);
      throw error;
    }
  }

  async onPrompt(context: LlmProxyPromptContext): Promise<void> {
    await this.dispatch(context, "onPrompt");
  }

  async onBeforeModel(context: LlmProxyBeforeModelContext): Promise<void> {
    await this.dispatch(context, "onBeforeModel");
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
      if (outcome.decision === "refuse") return outcome;
    }
    return outcome;
  }

  async onToolResults(
    context: LlmProxyToolResultsContext,
  ): Promise<LlmProxyToolResultsOutcome> {
    const updates: Record<string, string> = {};
    for (const plugin of this.getSessionPlugins(context)) {
      const result = (await this.invoke(plugin, "onToolResults", context)) as
        | LlmProxyToolResultsOutcome
        | undefined;
      if (result) Object.assign(updates, result.toolResultUpdates);
    }
    return { toolResultUpdates: updates };
  }

  async onModelResponse(
    context: LlmProxyModelResponseContext,
  ): Promise<unknown> {
    let response = context.response;
    for (const plugin of this.getSessionPlugins(context)) {
      const result = (await this.invoke(plugin, "onModelResponse", {
        ...context,
        response,
      })) as { response: unknown } | undefined;
      if (result) response = result.response;
    }
    return response;
  }

  async complete(context: LlmProxyCompleteContext): Promise<void> {
    const plugins = this.getSessionPlugins(context);
    try {
      for (const plugin of plugins) {
        await this.invoke(plugin, "onComplete", context);
      }
    } finally {
      await this.cleanup(context, plugins);
      this.sessions.delete(context.requestId);
    }
  }

  async fail(context: LlmProxyErrorContext): Promise<void> {
    const plugins = this.sessions.get(context.requestId);
    if (!plugins) return;
    try {
      for (const plugin of plugins) {
        await this.invoke(plugin, "onError", context);
      }
    } finally {
      await this.cleanup(context, plugins);
      this.sessions.delete(context.requestId);
    }
  }

  private async dispatch<
    TContext extends LlmProxyRequestContext,
    TPhase extends "onPrompt" | "onBeforeModel",
  >(context: TContext, phase: TPhase): Promise<void> {
    for (const plugin of this.getSessionPlugins(context)) {
      await this.invoke(plugin, phase, context);
    }
  }

  private getSessionPlugins(context: LlmProxyRequestContext): LlmProxyPlugin[] {
    const plugins = this.sessions.get(context.requestId);
    if (!plugins)
      throw new Error(`LLM proxy request ${context.requestId} is not active`);
    return plugins;
  }

  private async cleanup(
    context: LlmProxyRequestContext,
    plugins: readonly LlmProxyPlugin[],
  ): Promise<void> {
    let firstError: unknown;
    for (const plugin of [...plugins].reverse()) {
      try {
        await this.invoke(plugin, "onCleanup", context);
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
