import config from "@/config";
import logger from "@/logging";
import {
  isDelegationMarkerItem,
  isDelegationMarkerLine,
} from "@/openappa/delegation";
import { canonicalJson } from "@/openappa/wire";
import type {
  CommonToolResult,
  DualLlmAnalysis,
  HostedToolCall,
  UnsafeContextBoundary,
} from "@/types";
import { ApiError } from "@/types";

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
  resources: Map<PropertyKey, unknown>;
};

export type LlmProxyPromptContext = LlmProxyRequestContext & {
  prompt: unknown;
};

export type LlmProxyBeforeModelContext = LlmProxyRequestContext & {
  request: unknown;
};

/**
 * Provider-neutral tool calls retain parsed arguments when an adapter already
 * has them. Plugins must support either representation; the handler serializes
 * them only when it returns to a provider-specific response adapter.
 */
type LlmProxyToolCall = {
  id: string;
  name: string;
  arguments: string | Record<string, unknown>;
  /** The namespace the model called the tool in, on a wire that has them. */
  namespace?: string;
  /**
   * The id the client is given for this call when it is not the provider's:
   * OpenAPPA's trajectory stamp. Matching against the provider's response
   * stays on `id`; only what is written to the client changes.
   */
  wireId?: string;
};

export type LlmProxyToolCallsContext = LlmProxyRequestContext & {
  toolCalls: readonly LlmProxyToolCall[];
  /**
   * True when the transport can re-emit tool calls returned by plugins.
   * If false, the client receives raw streamed calls and plugins must not alter approved calls.
   */
  canRewriteToolCalls?: boolean;
};

/** A plugin-provided tool-call refusal rendered by the proxy's adapters. */
export type LlmProxyToolCallRefusal = {
  refusalMessage: string;
  contentMessage: string;
  reason: string;
  blockedToolName: string;
  blockedToolId?: string;
  toolInput: Record<string, unknown>;
  allToolCallNames: string[];
};

/**
 * Record of content appended to an approved tool call by a finalizer.
 * Contains either a text delegation marker or a structured marker item.
 */
export type LlmProxyToolCallAnnotation = {
  id: string;
  name: string;
  field: string;
  appended: string | Record<string, unknown>;
};

/**
 * Outcome of plugin tool call evaluation.
 * `blocked` lists calls replaced with notice calls.
 * `annotated` lists approved calls with appended delegation markers.
 */
export type LlmProxyToolCallsOutcome =
  | {
      decision: "allow";
      toolCalls: readonly LlmProxyToolCall[];
      blocked?: readonly { id: string; name: string; reason: string }[];
      annotated?: readonly LlmProxyToolCallAnnotation[];
    }
  | { decision: "refuse"; refusal: LlmProxyToolCallRefusal };

export type LlmProxyHostedToolCallsContext = LlmProxyRequestContext & {
  hostedToolCalls: readonly HostedToolCall[];
};

/**
 * What to do with the part of a turn the provider ran tools for: hand it to
 * the client as it is, or withhold it and send `notices` in its place.
 */
export type LlmProxyHostedToolCallsOutcome =
  | { decision: "release" }
  | {
      decision: "hold";
      notices: readonly LlmProxyToolCall[];
      blocked: readonly { id: string; name: string; reason: string }[];
    };

export type LlmProxyToolResult = CommonToolResult;

export type LlmProxyToolResultsContext = LlmProxyRequestContext & {
  toolResults: readonly LlmProxyToolResult[];
};

export type LlmProxyContextTrust = {
  contextIsTrusted: boolean;
  dualLlmAnalyses: DualLlmAnalysis[];
  unsafeContextBoundary: UnsafeContextBoundary | undefined;
};

/**
 * Uses the request adapter's existing provider-wire update path. Later plugins
 * receive the cumulative updates from earlier plugins in registration order.
 */
export type LlmProxyToolResultsOutcome = {
  toolResultUpdates: Readonly<Record<string, string>>;
  /** The final plugin-provided context trust decision, if one was made. */
  contextTrust?: LlmProxyContextTrust;
};

export type LlmProxyModelResponseContext = LlmProxyRequestContext & {
  response: unknown;
};

export type LlmProxyBufferedModelResponseContext =
  LlmProxyModelResponseContext & {
    /** Complete assistant response text gathered before releasing bytes to client. */
    responseText: string;
  };

export type LlmProxyBufferedModelResponseOutcome =
  | { decision: "release" }
  | { decision: "replace"; responseText: string };

export type LlmProxyCompleteContext = LlmProxyRequestContext & {
  response?: unknown;
};

export type LlmProxyErrorContext = LlmProxyRequestContext & {
  error: unknown;
};

export interface LlmProxyPlugin {
  readonly id: string;
  /** Finalizers reserve approved calls and run after the host's policy check. */
  readonly finalizesToolCalls?: boolean;
  onSessionInit?(context: LlmProxyRequestContext): Promise<void>;
  onPrompt?(context: LlmProxyPromptContext): Promise<void>;
  onBeforeModel?(context: LlmProxyBeforeModelContext): Promise<void>;
  /** Transport annotations run before host policy checks and reservations. */
  onPrepareToolCalls?(
    context: LlmProxyToolCallsContext,
  ): Promise<LlmProxyToolCallsOutcome | undefined>;
  onToolCalls?(
    context: LlmProxyToolCallsContext,
  ): Promise<LlmProxyToolCallsOutcome | undefined>;
  onToolResults?(
    context: LlmProxyToolResultsContext,
  ): Promise<LlmProxyToolResultsOutcome | undefined>;
  /** True when this plugin will rule on this request's provider-run calls. */
  governsHostedToolCalls?(context: LlmProxyRequestContext): boolean;
  /** Runs before `onToolCalls`: what a hosted call brought in comes first. */
  onHostedToolCalls?(
    context: LlmProxyHostedToolCallsContext,
  ): Promise<LlmProxyHostedToolCallsOutcome | undefined>;
  /** Returns true if this request buffers model output before release. */
  buffersModelResponse?(context: LlmProxyRequestContext): boolean;
  /** Evaluates buffered response text before sending content to client. */
  onBufferedModelResponse?(
    context: LlmProxyBufferedModelResponseContext,
  ): Promise<LlmProxyBufferedModelResponseOutcome | undefined>;
  /**
   * Runs before a non-streaming response is released. Streaming responses are
   * observable only after their already-forwarded chunks are assembled; returned
   * replacements are ignored when context.streaming is true.
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

  async onSessionInit(context: LlmProxyRequestContext): Promise<void> {
    if (!this.hasPlugins()) return;
    if (this.sessions.has(context.requestId)) {
      throw new Error(
        `LLM proxy request ${context.requestId} is already active`,
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
        await this.cleanup(context, initialized);
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
    validate?: (
      toolCalls: LlmProxyToolCallsContext["toolCalls"],
    ) => Promise<LlmProxyToolCallRefusal | null>,
  ): Promise<LlmProxyToolCallsOutcome> {
    let toolCalls = context.toolCalls;
    const plugins = this.hasPlugins() ? this.getSessionPlugins(context) : [];
    // Rewriters run first. The host checks exactly those calls before a
    // finalizer such as APPA records any reservation for execution.
    for (const plugin of plugins.filter(
      (plugin) => !plugin.finalizesToolCalls,
    )) {
      const result = await this.invoke(plugin, "onToolCalls", {
        ...context,
        toolCalls,
      });
      if (!result) continue;
      if (result.decision === "refuse") return result;
      toolCalls = result.toolCalls;
    }
    for (const plugin of plugins) {
      const prepared = await this.invoke(plugin, "onPrepareToolCalls", {
        ...context,
        toolCalls,
      });
      if (!prepared) continue;
      if (prepared.decision === "refuse") return prepared;
      toolCalls = prepared.toolCalls;
    }
    const refusal = await validate?.(toolCalls);
    if (refusal) return { decision: "refuse", refusal };
    let blocked: readonly { id: string; name: string; reason: string }[] = [];
    for (const plugin of plugins.filter(
      (plugin) => plugin.finalizesToolCalls,
    )) {
      // Capture values before the callback: retaining object references would
      // let an in-place mutation evade the post-validation rewrite check.
      const given = new Map(
        toolCalls.map((call) => [
          call.id,
          {
            name: call.name,
            namespace: call.namespace,
            arguments: canonicalJson(call.arguments),
          },
        ]),
      );
      const result = (await this.invoke(plugin, "onToolCalls", {
        ...context,
        toolCalls,
      })) ?? { decision: "allow" as const, toolCalls };
      if (result.decision === "refuse") return result;
      // A finalizer cannot release a tool call that policies never evaluated.
      // Every returned call must match one of the input calls:
      // - Untouched
      // - Reported as blocked (replaced with a platform notice call)
      // - Reported as annotated (with only an approved delegation marker appended)
      for (const entry of result.blocked ?? []) {
        // Validate that reported blocked calls were part of the input batch.
        if (given.get(entry.id)?.name !== entry.name) {
          throw new Error(
            `Finalizer ${plugin.id} reported a block on a call the policies never saw: ${entry.id}`,
          );
        }
      }
      const blockedIds = new Set(
        (result.blocked ?? []).map((entry) => entry.id),
      );
      const annotations = new Map<string, LlmProxyToolCallAnnotation>();
      for (const entry of result.annotated ?? []) {
        if (
          given.get(entry.id)?.name !== entry.name ||
          blockedIds.has(entry.id) ||
          annotations.has(entry.id)
        ) {
          throw new Error(
            `Finalizer ${plugin.id} reported an annotation on a call the policies never saw: ${entry.id}`,
          );
        }
        annotations.set(entry.id, entry);
      }
      const returned = new Set<string>();
      for (const call of result.toolCalls) {
        const original = given.get(call.id);
        if (!original || returned.has(call.id)) {
          throw new Error(
            `Finalizer ${plugin.id} returned a call the policies never saw: ${call.id}`,
          );
        }
        returned.add(call.id);
        const untouched =
          original.name === call.name &&
          original.namespace === call.namespace &&
          original.arguments === canonicalJson(call.arguments);
        if (untouched || blockedIds.has(call.id)) continue;
        const annotation = annotations.get(call.id);
        if (
          !annotation ||
          original.name !== call.name ||
          original.namespace !== call.namespace ||
          !appendsOnlyMarker({
            before: original.arguments,
            after: canonicalJson(call.arguments),
            annotation,
          })
        ) {
          throw new Error(
            `Finalizer ${plugin.id} rewrote a call it did not report as blocked: ${call.id}`,
          );
        }
        annotations.delete(call.id);
      }
      // Validates that all reported annotations were applied to returned calls.
      const unapplied = annotations.keys().next();
      if (!unapplied.done) {
        throw new Error(
          `Finalizer ${plugin.id} reported an annotation it did not make: ${unapplied.value}`,
        );
      }
      toolCalls = result.toolCalls;
      if (result.blocked?.length) blocked = [...blocked, ...result.blocked];
    }
    // Only carried when a finalizer actually substituted something, so the
    // ordinary outcome stays the shape every other caller already matches.
    return blocked.length
      ? { decision: "allow", toolCalls, blocked }
      : { decision: "allow", toolCalls };
  }

  async onToolResults(
    context: LlmProxyToolResultsContext,
  ): Promise<LlmProxyToolResultsOutcome> {
    if (!this.hasPlugins()) return EMPTY_TOOL_RESULTS_OUTCOME;
    const updates: Record<string, string> = {};
    let toolResults = context.toolResults;
    let contextTrust: LlmProxyContextTrust | undefined;
    for (const plugin of this.getSessionPlugins(context)) {
      const result = await this.invoke(plugin, "onToolResults", {
        ...context,
        toolResults,
      });
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

  governsHostedToolCalls(context: LlmProxyRequestContext): boolean {
    return this.getSessionPlugins(context).some(
      (plugin) => plugin.governsHostedToolCalls?.(context) === true,
    );
  }

  buffersModelResponse(context: LlmProxyRequestContext): boolean {
    return this.getSessionPlugins(context).some(
      (plugin) => plugin.buffersModelResponse?.(context) === true,
    );
  }

  async onBufferedModelResponse(
    context: LlmProxyBufferedModelResponseContext,
  ): Promise<LlmProxyBufferedModelResponseOutcome> {
    let responseText = context.responseText;
    let replaced = false;
    for (const plugin of this.getSessionPlugins(context)) {
      if (plugin.buffersModelResponse?.(context) !== true) continue;
      const result = await this.invoke(plugin, "onBufferedModelResponse", {
        ...context,
        responseText,
      });
      if (result?.decision !== "replace") continue;
      responseText = result.responseText;
      replaced = true;
    }
    return replaced
      ? { decision: "replace", responseText }
      : { decision: "release" };
  }

  /** The first plugin to withhold the provider-run part of the turn decides. */
  async onHostedToolCalls(
    context: LlmProxyHostedToolCallsContext,
  ): Promise<LlmProxyHostedToolCallsOutcome> {
    for (const plugin of this.getSessionPlugins(context)) {
      const result = await this.invoke(plugin, "onHostedToolCalls", context);
      if (result?.decision === "hold") return result;
    }
    return { decision: "release" };
  }

  async onModelResponse(
    context: LlmProxyModelResponseContext,
  ): Promise<unknown> {
    if (!this.hasPlugins()) return context.response;
    let response = context.response;
    for (const plugin of this.getSessionPlugins(context)) {
      const result = await this.invoke(plugin, "onModelResponse", {
        ...context,
        response,
      });
      if (result) response = result.response;
    }
    return response;
  }

  async complete(context: LlmProxyCompleteContext): Promise<void> {
    if (!this.hasPlugins()) return;
    const plugins = this.getSessionPlugins(context);
    try {
      for (const plugin of plugins) {
        await this.invoke(plugin, "onComplete", context);
      }
    } finally {
      try {
        await this.cleanup(context, plugins);
      } finally {
        this.sessions.delete(context.requestId);
      }
    }
  }

  async fail(context: LlmProxyErrorContext): Promise<void> {
    if (!this.hasPlugins()) return;
    const plugins = this.sessions.get(context.requestId);
    if (!plugins) return;
    try {
      for (const plugin of plugins) {
        await this.invoke(plugin, "onError", context);
      }
    } finally {
      try {
        await this.cleanup(context, plugins);
      } finally {
        this.sessions.delete(context.requestId);
      }
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
    if (!this.hasPlugins()) return [];
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

  private async invoke(
    plugin: LlmProxyPlugin,
    phase: "onToolCalls" | "onPrepareToolCalls",
    context: LlmProxyToolCallsContext,
  ): Promise<LlmProxyToolCallsOutcome | undefined>;
  private async invoke(
    plugin: LlmProxyPlugin,
    phase: "onToolResults",
    context: LlmProxyToolResultsContext,
  ): Promise<LlmProxyToolResultsOutcome | undefined>;
  private async invoke(
    plugin: LlmProxyPlugin,
    phase: "onHostedToolCalls",
    context: LlmProxyHostedToolCallsContext,
  ): Promise<LlmProxyHostedToolCallsOutcome | undefined>;
  private async invoke(
    plugin: LlmProxyPlugin,
    phase: "onModelResponse",
    context: LlmProxyModelResponseContext,
  ): Promise<{ response: unknown } | undefined>;
  private async invoke(
    plugin: LlmProxyPlugin,
    phase: "onBufferedModelResponse",
    context: LlmProxyBufferedModelResponseContext,
  ): Promise<LlmProxyBufferedModelResponseOutcome | undefined>;
  private async invoke<
    TPhase extends keyof LlmProxyPlugin,
    TContext extends LlmProxyRequestContext,
  >(plugin: LlmProxyPlugin, phase: TPhase, context: TContext): Promise<unknown>;
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
      // An ApiError is already the answer this request should get — a fail-closed
      // 503 from the runtime, a 400 for a request it cannot govern. Wrapping it
      // would turn a deliberate status into an internal error.
      if (cause instanceof ApiError) throw cause;
      throw new LlmProxyPluginError({ pluginId: plugin.id, phase, cause });
    }
  }
}

const defaultLlmProxyPluginRegistry = new LlmProxyPluginRegistry();
const EMPTY_TOOL_RESULTS_OUTCOME: LlmProxyToolResultsOutcome = {
  toolResultUpdates: {},
};

/** @public — test-only loader injection verifies startup retry semantics. */
export class LlmProxyPluginInitializer {
  private initialization: Promise<void> | undefined;

  constructor(
    private readonly registry: LlmProxyPluginRegistry,
    private readonly loadPlugins: () => Promise<readonly LlmProxyPlugin[]>,
  ) {}

  initialize(): Promise<void> {
    if (this.initialization) return this.initialization;

    const initialization = this.loadAndRegister();
    this.initialization = initialization;
    // Keep the caller's rejection intact while allowing a later startup attempt
    // to retry instead of permanently retaining this rejected promise.
    void initialization.catch(() => {
      if (this.initialization === initialization) {
        this.initialization = undefined;
      }
    });
    return initialization;
  }

  private async loadAndRegister(): Promise<void> {
    const plugins = await this.loadPlugins();
    this.registry.registerAll(plugins);
  }
}

const defaultLlmProxyPluginInitializer = new LlmProxyPluginInitializer(
  defaultLlmProxyPluginRegistry,
  loadConfiguredLlmProxyPlugins,
);

/** Loads and registers the deployment's allowlisted proxy plugins once at startup. */
export function initializeLlmProxyPlugins(): Promise<void> {
  return defaultLlmProxyPluginInitializer.initialize();
}

/** @public — test-only registration verifies generic lifecycle behavior. */
export function registerLlmProxyPlugin(plugin: LlmProxyPlugin): () => void {
  return defaultLlmProxyPluginRegistry.register(plugin);
}

/** Returns the proxy's process-wide plugin registry. */
export function getLlmProxyPluginRegistry(): LlmProxyPluginRegistry {
  return defaultLlmProxyPluginRegistry;
}

/**
 * Returns true if `after` differs from `before` only by the appended delegation marker.
 * Compares canonical JSON representations to prevent unverified mutations.
 */
function appendsOnlyMarker(params: {
  before: string;
  after: string;
  annotation: LlmProxyToolCallAnnotation;
}): boolean {
  const before = argumentRecord(params.before);
  const after = argumentRecord(params.after);
  if (!before || !after) return false;
  const { field, appended } = params.annotation;
  const keys = Object.keys(before).sort();
  if (canonicalJson(keys) !== canonicalJson(Object.keys(after).sort()))
    return false;
  for (const key of keys) {
    if (
      key !== field &&
      canonicalJson(before[key]) !== canonicalJson(after[key])
    )
      return false;
  }
  const was = before[field];
  const now = after[field];
  if (typeof appended === "string") {
    return (
      typeof was === "string" &&
      was.trim().length > 0 &&
      appended.startsWith("\n\n") &&
      isDelegationMarkerLine(appended.slice(2)) &&
      now === was + appended
    );
  }
  return (
    Array.isArray(was) &&
    was.length > 0 &&
    isDelegationMarkerItem(appended) &&
    canonicalJson(now) === canonicalJson([...was, appended])
  );
}

/** A call's arguments from its snapshot: an object, or JSON text of one. */
function argumentRecord(snapshot: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(snapshot);
    const parsed: unknown =
      typeof value === "string" ? JSON.parse(value) : value;
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

async function loadConfiguredLlmProxyPlugins(): Promise<
  readonly LlmProxyPlugin[]
> {
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
}
