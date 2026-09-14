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
} from "@/plugins/llm-proxy-plugin";
import {
  type AppaOutboundToolCall,
  AppaProxyHookSession,
  canonicalJsonObject,
} from "@/routes/proxy/appa-proxy-hook";
import { AppaProxyLedger } from "@/services/appa-proxy/ledger";
import type { AppaClientAdapter } from "./types";

/**
 * Foundational appa-plugin-archestra meta-plugin.
 * Encapsulates and manages durable ledger operations transparently to all
 * external actors and mediates communication between Archestra LLM-proxy
 * and OpenAPPA appa-runtime.
 */
export class AppaPluginArchestra implements LlmProxyPlugin {
  readonly id = "archestra.appa";

  private readonly clientAdapters = new Map<string, AppaClientAdapter>();
  private readonly sessions = new Map<
    string,
    {
      session: AppaProxyHookSession;
      adapter?: AppaClientAdapter;
      promptSent: boolean;
    }
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
    const binding = context.resources.get(this.id);
    if (!isProxySessionBinding(binding)) return;
    if (this.sessions.has(context.requestId)) {
      throw new Error(`APPA session ${context.requestId} is already bound`);
    }
    this.sessions.set(context.requestId, { ...binding, promptSent: false });
  }

  async onPrompt(context: LlmProxyPromptContext): Promise<void> {
    const state = this.sessions.get(context.requestId);
    if (!state) return;
    await state.session.sendPrompt(context.prompt);
    state.promptSent = true;
  }

  async onToolCalls(
    context: LlmProxyToolCallsContext,
  ): Promise<LlmProxyToolCallsOutcome | undefined> {
    const state = this.sessions.get(context.requestId);
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
        message:
          error instanceof Error
            ? error.message
            : "APPA policy denied tool execution",
      };
    }
  }

  async onToolResults(
    context: LlmProxyToolResultsContext,
  ): Promise<LlmProxyToolResultsOutcome | undefined> {
    const state = this.sessions.get(context.requestId);
    if (!state) return;
    return {
      toolResults: context.toolResults,
      modelUpdates: state.session.getModelResultUpdates(),
    };
  }

  async onTurnEnd(context: LlmProxyTurnEndContext): Promise<void> {
    const state = this.sessions.get(context.requestId);
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
      this.sessions.delete(context.requestId);
    }
  }

  async onAbort(context: LlmProxyRequestContext): Promise<void> {
    const state = this.sessions.get(context.requestId);
    if (!state) return;
    try {
      if (state.promptSent) {
        await state.session.abort();
      } else {
        await state.session.releaseWithoutPrompt();
      }
    } finally {
      this.sessions.delete(context.requestId);
    }
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
}

function isProxySessionBinding(
  value: unknown,
): value is { session: AppaProxyHookSession; adapter?: AppaClientAdapter } {
  return (
    typeof value === "object" &&
    value !== null &&
    "session" in value &&
    value.session instanceof AppaProxyHookSession
  );
}
