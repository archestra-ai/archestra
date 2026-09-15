import config from "@/config";
import logger from "@/logging";
import type {
  CommonToolResult,
  DualLlmAnalysis,
  UnsafeContextBoundary,
} from "@/types";

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
  interactionType: string;
  streaming: boolean;
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
  resources: Map<PropertyKey, unknown>;
  signal?: AbortSignal;
};

export type LlmProxyPromptContext = LlmProxyRequestContext & {
  prompt: unknown;
};

export type LlmProxyBeforeModelContext = LlmProxyRequestContext & {
  request: unknown;
};

export type LlmProxyToolCall = {
  id: string;
  name: string;
  arguments: string | Record<string, unknown>;
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

export type LlmProxyToolCallRefusal = {
  refusalMessage: string;
  contentMessage: string;
  reason: string;
  blockedToolName: string;
  blockedToolId?: string;
  toolInput: Record<string, unknown>;
  allToolCallNames: string[];
};

export type LlmProxyToolCallsOutcome =
  | { decision: "allow"; toolCalls: readonly LlmProxyToolCall[] }
  | {
      decision: "refuse";
      refusal: LlmProxyToolCallRefusal;
    };

export type LlmProxyToolResult = CommonToolResult;

export type LlmProxyToolResultsContext = LlmProxyRequestContext & {
  toolResults: readonly LlmProxyToolResult[];
};

export type LlmProxyToolResultsOutcome = {
  toolResultUpdates: Readonly<Record<string, string>>;
  contextTrust?: LlmProxyContextTrust;
};

export type LlmProxyContextTrust = {
  contextIsTrusted: boolean;
  dualLlmAnalyses: DualLlmAnalysis[];
  unsafeContextBoundary: UnsafeContextBoundary | undefined;
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
  onTurnEnd?(context: LlmProxyTurnEndContext): Promise<void>;
  onChildStart?(context: LlmProxyChildContext): Promise<void>;
  onChildEnd?(context: LlmProxyChildContext): Promise<void>;
  onAbort?(context: LlmProxyRequestContext): Promise<void>;
  onModelResponse?(
    context: LlmProxyModelResponseContext,
  ): Promise<{ response: unknown } | undefined>;
  onComplete?(context: LlmProxyCompleteContext): Promise<void>;
  onError?(context: LlmProxyErrorContext): Promise<void>;
  onCleanup?(context: LlmProxyRequestContext): Promise<void>;
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
    this.registerAll([plugin]);
    return () => {
      const index = this.plugins.indexOf(plugin);
      if (index >= 0) this.plugins.splice(index, 1);
    };
  }

  registerAll(plugins: readonly LlmProxyPlugin[]): void {
    const ids = new Set(this.plugins.map((plugin) => plugin.id));
    for (const plugin of plugins) {
      if (ids.has(plugin.id)) {
        throw new Error(`LLM proxy plugin ${plugin.id} is already registered`);
      }
      ids.add(plugin.id);
    }
    this.plugins.push(...plugins);
  }

  hasPlugins(): boolean {
    return this.plugins.length > 0;
  }

  getPlugin<T extends LlmProxyPlugin>(id: string): T | undefined {
    return this.plugins.find((plugin) => plugin.id === id) as T | undefined;
  }

  async onSessionInit(context: LlmProxyRequestContext): Promise<void> {
    if (!this.hasPlugins()) return;
    if (this.sessions.has(context.requestId)) {
      throw new Error(
        `LLM proxy session ${context.requestId} is already active`,
      );
    }

    const initialized: LlmProxyPlugin[] = [];
    this.sessions.set(context.requestId, initialized);
    try {
      for (const plugin of this.plugins) {
        initialized.push(plugin);
        await this.invoke(plugin, "onSessionInit", context);
      }
    } catch (error) {
      try {
        await this.abortInitialized(context, initialized);
      } catch {
        // Initialization is the primary failure. Abort is best-effort here,
        // but always releases registry state for a later request with this id.
      } finally {
        this.sessions.delete(context.requestId);
      }
      throw error;
    }
  }

  async onPrompt(context: LlmProxyPromptContext): Promise<void> {
    if (!this.hasPlugins()) return;
    await this.dispatch(context, "onPrompt");
  }

  async onBeforeModel(context: LlmProxyBeforeModelContext): Promise<void> {
    if (!this.hasPlugins()) return;
    await this.dispatch(context, "onBeforeModel");
  }

  async onToolCalls(
    context: LlmProxyToolCallsContext,
  ): Promise<LlmProxyToolCallsOutcome> {
    if (!this.hasPlugins()) {
      return { decision: "allow", toolCalls: context.toolCalls };
    }
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
    if (!this.hasPlugins()) return EMPTY_TOOL_RESULTS_OUTCOME;
    const updates: Record<string, string> = {};
    let toolResults = context.toolResults;
    let contextTrust: LlmProxyContextTrust | undefined;
    for (const plugin of this.getSessionPlugins(context)) {
      const result = (await this.invoke(plugin, "onToolResults", {
        ...context,
        toolResults,
      })) as LlmProxyToolResultsOutcome | undefined;
      if (!result) continue;
      Object.assign(updates, result.toolResultUpdates);
      if (result.contextTrust) contextTrust = result.contextTrust;
      toolResults = toolResults.map((toolResult) => ({
        ...toolResult,
        content: result.toolResultUpdates[toolResult.id] ?? toolResult.content,
      }));
    }
    return {
      toolResultUpdates: updates,
      ...(contextTrust ? { contextTrust } : {}),
    };
  }

  async onTurnEnd(context: LlmProxyTurnEndContext): Promise<void> {
    if (!this.hasPlugins()) return;
    const plugins = this.getSessionPlugins(context);
    try {
      for (const plugin of plugins) {
        await this.invoke(plugin, "onTurnEnd", context);
      }
    } catch (error) {
      try {
        await this.abortInitialized(context, plugins);
      } catch {
        // The turn-end failure remains the request failure.
      } finally {
        this.sessions.delete(context.requestId);
      }
      throw error;
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

  async onModelResponse(
    context: LlmProxyModelResponseContext,
  ): Promise<unknown> {
    if (!this.hasPlugins()) return context.response;
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
    if (!this.hasPlugins()) return;
    const plugins = this.getSessionPlugins(context);
    let primaryError: unknown;
    try {
      for (const plugin of plugins)
        await this.invoke(plugin, "onComplete", context);
    } catch (error) {
      primaryError = error;
    } finally {
      try {
        await this.cleanup(context, plugins);
      } catch (cleanupError) {
        if (!primaryError) primaryError = cleanupError;
      } finally {
        this.sessions.delete(context.requestId);
      }
    }
    if (primaryError) throw primaryError;
  }

  async fail(context: LlmProxyErrorContext): Promise<void> {
    if (!this.hasPlugins()) return;
    const plugins = this.sessions.get(context.requestId);
    if (!plugins) return;
    let primaryError: unknown;
    try {
      for (const plugin of plugins)
        await this.invoke(plugin, "onError", context);
    } catch (error) {
      primaryError = error;
    } finally {
      try {
        await this.cleanup(context, plugins);
      } catch (cleanupError) {
        if (!primaryError) primaryError = cleanupError;
      } finally {
        this.sessions.delete(context.requestId);
      }
    }
    if (primaryError) throw primaryError;
  }

  private async dispatch<
    TContext extends LlmProxyRequestContext,
    TPhase extends
      | "onPrompt"
      | "onBeforeModel"
      | "onTurnEnd"
      | "onChildStart"
      | "onChildEnd",
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

  private async cleanup(
    context: LlmProxyRequestContext,
    plugins: readonly LlmProxyPlugin[],
  ): Promise<void> {
    let firstError: unknown;
    for (const plugin of [...plugins].reverse()) {
      try {
        await this.invoke(plugin, "onCleanup", context);
      } catch (error) {
        if (firstError) {
          logger.warn(
            { err: error, pluginId: plugin.id },
            "Suppressed LLM proxy plugin cleanup error",
          );
        }
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
const EMPTY_TOOL_RESULTS_OUTCOME: LlmProxyToolResultsOutcome = {
  toolResultUpdates: {},
};

class LlmProxyPluginInitializer {
  private initialization: Promise<void> | undefined;

  constructor(
    private readonly registry: LlmProxyPluginRegistry,
    private readonly loadPlugins: () => Promise<readonly LlmProxyPlugin[]>,
  ) {}

  initialize(): Promise<void> {
    if (this.initialization) return this.initialization;
    const initialization = this.loadPlugins().then((plugins) =>
      this.registry.registerAll(plugins),
    );
    this.initialization = initialization;
    void initialization.catch(() => {
      if (this.initialization === initialization)
        this.initialization = undefined;
    });
    return initialization;
  }
}

const defaultLlmProxyPluginInitializer = new LlmProxyPluginInitializer(
  defaultLlmProxyPluginRegistry,
  async () => {
    const plugins: LlmProxyPlugin[] = [];
    for (const pluginName of config.llmProxy.plugins) {
      if (pluginName === "appa") {
        const { createAppaLlmProxyPlugin } = await import(
          "./appa-plugin-archestra"
        );
        plugins.push(createAppaLlmProxyPlugin());
      }
    }
    return plugins;
  },
);

/** Loads the configured allowlist once per process, retrying failed attempts. */
export function initializeLlmProxyPlugins(): Promise<void> {
  return defaultLlmProxyPluginInitializer.initialize();
}

/** Returns the proxy's process-wide plugin registry. */
export function getLlmProxyPluginRegistry(): LlmProxyPluginRegistry {
  return defaultLlmProxyPluginRegistry;
}
