import { AppaProxySessionProtocolError } from "@/models";
import type {
  LlmProxyPlugin,
  LlmProxyPromptContext,
  LlmProxyRequestContext,
  LlmProxyToolCallsContext,
  LlmProxyToolCallsOutcome,
  LlmProxyToolResultsContext,
  LlmProxyToolResultsOutcome,
  LlmProxyTurnEndContext,
} from "@/proxy/plugins/registry";
import {
  type AppaOutboundToolCall,
  type AppaProxyHookSession,
  canonicalJsonObject,
} from "@/routes/proxy/appa-proxy-hook";
import { AppaProxyLedger } from "@/services/appa-proxy/ledger";
import {
  APPA_PLUGIN_HOST_BINDING,
  type AppaClientAdapter,
  type AppaPluginHostBinding,
  type AppaTrustedContext,
} from "./types";

/**
 * Foundational appa-plugin-archestra meta-plugin.
 * Encapsulates and manages durable ledger operations transparently to all
 * external actors and mediates communication between Archestra LLM-proxy
 * and OpenAPPA appa-runtime.
 */
export class AppaPluginArchestra implements LlmProxyPlugin {
  readonly id = "archestra.appa";

  private readonly clientAdapters = new Map<string, AppaClientAdapter>();
  private readonly bindings = new WeakMap<
    object,
    AppaPluginHostBinding & { promptSent: boolean }
  >();

  /**
   * Register a client-specific adapter (e.g. appa-plugin-archestra-claude-code,
   * appa-plugin-archestra-codex, appa-plugin-archestra-opencode).
   */
  registerClientAdapter(adapter: AppaClientAdapter): void {
    this.clientAdapters.set(adapter.id, adapter);
  }

  getClientAdapters(): AppaClientAdapter[] {
    return Array.from(this.clientAdapters.values());
  }

  resolveClientAdapter(context: {
    protocol: "anthropic" | "responses" | "chat_completions";
    provider?: string;
    headers: Record<string, string | string[] | undefined>;
    requestBody: unknown;
  }): AppaClientAdapter | undefined {
    for (const adapter of this.clientAdapters.values()) {
      if (adapter.matches(context)) {
        return adapter;
      }
    }
    return undefined;
  }

  async onSessionInit(context: LlmProxyRequestContext): Promise<void> {
    this.bindings.delete(context.resources);
    const hostBinding = getHostBinding(context.resources);
    if (!hostBinding) return;
    const adapter =
      hostBinding.adapter ??
      this.findAdapter({
        headers: context.headers,
        requestBody: context.requestBody,
        trustedContext: hostBinding.trustedContext,
      });
    this.bindings.set(context.resources, {
      ...hostBinding,
      ...(adapter ? { adapter } : {}),
      promptSent: false,
    });
  }

  async onPrompt(context: LlmProxyPromptContext): Promise<void> {
    const state = this.bindings.get(context.resources);
    if (!state) return;
    await state.session.sendPrompt(context.prompt);
    state.promptSent = true;
  }

  async onToolCalls(
    context: LlmProxyToolCallsContext,
  ): Promise<LlmProxyToolCallsOutcome | undefined> {
    const state = this.bindings.get(context.resources);
    if (!state || context.toolCalls.length === 0) return;

    try {
      const calls: AppaOutboundToolCall[] = context.toolCalls.map((call) => {
        const emittedArguments =
          typeof call.arguments === "string"
            ? call.arguments
            : JSON.stringify(call.arguments);
        return {
          id: call.id,
          emittedName: call.name,
          emittedArguments,
          emittedArgumentsCanonical: canonicalJsonObject(emittedArguments),
          targetName:
            call.target?.name ??
            state.adapter?.canonicalizeLocalToolName?.(call.name) ??
            call.name,
          targetArguments: (call.target?.arguments ?? call.arguments) as Record<
            string,
            unknown
          >,
          spawn: call.isChildSpawn === true,
        };
      });
      const authorized = await state.session.authorizeOutboundToolCalls(
        calls,
        this.nativeSpawnCarrierPreparation({
          session: state.session,
          profileId: context.profileId,
          adapter: state.adapter,
        }),
      );
      return {
        decision: "allow",
        toolCalls: authorized.map((call) => ({
          id: call.id,
          name: call.emittedName,
          arguments: call.emittedArguments,
        })),
      };
    } catch (error) {
      return {
        decision: "refuse",
        refusal: {
          refusalMessage: "OpenAPPA policy denied tool execution",
          contentMessage: "OpenAPPA policy denied tool execution",
          reason:
            error instanceof Error
              ? error.message
              : "APPA policy denied tool execution",
          blockedToolName:
            context.toolCalls[0]?.target?.name ??
            context.toolCalls[0]?.name ??
            "unknown",
          toolInput: {},
          allToolCallNames: context.toolCalls.map(
            (call) => call.target?.name ?? call.name,
          ),
        },
      };
    }
  }

  async onToolResults(
    context: LlmProxyToolResultsContext,
  ): Promise<LlmProxyToolResultsOutcome | undefined> {
    const state = this.bindings.get(context.resources);
    if (!state) return;
    return {
      toolResultUpdates: Object.fromEntries(
        state.session.getModelResultUpdates(),
      ),
    };
  }

  async onTurnEnd(context: LlmProxyTurnEndContext): Promise<void> {
    const state = this.bindings.get(context.resources);
    if (!state) return;
    try {
      if (context.deferCleanup) return;
      if (state.promptSent) {
        await state.session.finish({
          childReturn: context.resultText,
          awaitClientContinuation: context.awaitClientContinuation,
          beforeRelease: context.beforeResponseRelease,
        });
      } else {
        await state.session.releaseWithoutPrompt();
      }
    } finally {
      state.promptSent = false;
    }
  }

  async onAbort(context: LlmProxyRequestContext): Promise<void> {
    const state = this.bindings.get(context.resources);
    if (!state) return;
    try {
      if (state.promptSent) {
        await state.session.abort();
      } else {
        await state.session.releaseWithoutPrompt();
      }
    } finally {
      this.bindings.delete(context.resources);
    }
  }

  async onError(
    context: LlmProxyRequestContext & { error: unknown },
  ): Promise<void> {
    await this.onAbort(context);
  }

  async onCleanup(context: LlmProxyRequestContext): Promise<void> {
    this.bindings.delete(context.resources);
  }

  private nativeSpawnCarrierPreparation(params: {
    session: AppaProxyHookSession;
    profileId: string;
    adapter?: AppaClientAdapter;
  }):
    | {
        prepareSpawn: (
          call: AppaOutboundToolCall,
        ) => Promise<AppaOutboundToolCall>;
      }
    | undefined {
    const { adapter } = params;
    if (!adapter?.usesSpawnCarrier) return undefined;
    const ledger = new AppaProxyLedger({
      ...params.session.getNativeWireScope(),
      profileId: params.profileId,
    });
    return {
      prepareSpawn: async (call) => {
        let originalArguments: Record<string, unknown>;
        try {
          originalArguments = JSON.parse(call.emittedArguments) as Record<
            string,
            unknown
          >;
        } catch {
          throw new AppaProxySessionProtocolError(
            "Native spawn arguments must be a JSON object.",
          );
        }
        if (
          !originalArguments ||
          Array.isArray(originalArguments) ||
          typeof originalArguments.prompt !== "string"
        ) {
          throw new AppaProxySessionProtocolError(
            "Native spawn requires a documented prompt argument.",
          );
        }
        const prepared = await ledger.prepareChildCarrier({
          callId: call.id,
          originalArguments,
        });
        return {
          ...call,
          emittedArguments: JSON.stringify(prepared.rewrittenArguments),
          emittedArgumentsCanonical: prepared.rewrittenArgumentsCanonical,
          targetName:
            adapter.carrierSpawnTarget?.(call.targetName) ?? call.targetName,
          targetArguments: prepared.rewrittenArguments,
        };
      },
    };
  }

  private findAdapter(context: {
    headers: Record<string, string | string[] | undefined>;
    requestBody: unknown;
    trustedContext?: AppaTrustedContext;
  }): AppaClientAdapter | undefined {
    if (!context.trustedContext?.chatSource) return undefined;
    const chatAdapter = this.clientAdapters.get("archestra-chat");
    return chatAdapter?.matches({ ...context, protocol: "chat_completions" })
      ? chatAdapter
      : undefined;
  }
}

function getHostBinding(
  resources: ReadonlyMap<PropertyKey, unknown>,
): AppaPluginHostBinding | undefined {
  const value = resources.get(APPA_PLUGIN_HOST_BINDING);
  return typeof value === "object" &&
    value !== null &&
    "session" in value &&
    typeof value.session === "object" &&
    value.session !== null
    ? (value as AppaPluginHostBinding)
    : undefined;
}
