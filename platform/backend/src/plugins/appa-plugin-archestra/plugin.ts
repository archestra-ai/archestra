import { randomUUID } from "node:crypto";
import config from "@/config";
import {
  type AppaOutboundToolCall,
  AppaProxyHookSession,
  canonicalJsonObject,
} from "@/routes/proxy/appa-proxy-hook";
import type { AppaHistoryProtocol } from "@/services/appa-history-codec";
import {
  type AppaChildContext,
  type AppaClientAdapter,
  type AppaLifecycleHookCallbacks,
  type AppaPromptContext,
  type AppaSessionHookInstance,
  type AppaSessionInitContext,
  type AppaToolCall,
  type AppaToolCallsContext,
  type AppaToolCallsDecision,
  type AppaToolResult,
  type AppaToolResultContext,
  type AppaToolResultOutcome,
  type AppaTurnEndContext,
  isAppaSpawnTool,
} from "./types";

/**
 * Foundational appa-plugin-archestra meta-plugin.
 * Encapsulates and manages durable ledger operations transparently to all
 * external actors and mediates communication between Archestra LLM-proxy
 * and OpenAPPA appa-runtime.
 */
export class AppaPluginArchestra implements AppaLifecycleHookCallbacks {
  private clientAdapters: Map<string, AppaClientAdapter> = new Map();

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
    protocol: AppaSessionInitContext["protocol"];
    headers: Record<string, string | string[] | undefined>;
    requestBody: unknown;
  }): AppaClientAdapter | undefined {
    for (const adapter of this.clientAdapters.values()) {
      if (adapter.matches(context)) {
        return adapter;
      }
    }
    // Fallback by protocol
    for (const adapter of this.clientAdapters.values()) {
      if (adapter.protocol === context.protocol) {
        return adapter;
      }
    }
    return undefined;
  }

  /**
   * Lifecycle Hook Point: onSessionInit
   * Called during proxy pre-handling to initialize or resume an APPA session,
   * binding trajectory lineage in the durable ledger.
   */
  async onSessionInit(
    context: AppaSessionInitContext,
  ): Promise<AppaSessionHookInstance | undefined> {
    const hookConfig = config.llmProxy.appaHook;
    if (!hookConfig) {
      return undefined;
    }

    const adapter = this.resolveClientAdapter({
      protocol: context.protocol,
      headers: context.headers,
      requestBody: context.requestBody,
    });
    if (!adapter) {
      return undefined;
    }

    const identity = adapter.extractSessionIdentity({
      headers: context.headers,
      requestBody: context.requestBody,
    });

    const toolResults = adapter.extractToolResults(context.requestBody);

    const protocolMap: Record<string, AppaHistoryProtocol> = {
      anthropic: "anthropic-messages",
      responses: "openai-responses",
      chat_completions: "openai-chat-completions",
    };

    const session = await AppaProxyHookSession.acquire({
      config: hookConfig,
      profileId: context.profileId,
      ownerScopeHash: context.userId || "anonymous",
      clientSessionId: identity.clientSessionId ?? randomUUID(),
      parentClientSessionId: identity.parentSessionId,
      spawnBinding: identity.spawnBinding,
      provider: context.provider,
      protocol: protocolMap[context.protocol],
      model: context.model || "unknown",
      toolResults: toolResults.map((tr: AppaToolResult) => ({
        id: tr.id,
        content: tr.content,
        isError: tr.isError,
        claimedCall: tr.claimedCall
          ? {
              name: tr.claimedCall.name,
              rawArguments: JSON.stringify(tr.claimedCall.rawArguments),
            }
          : undefined,
      })),
    });

    return new AppaSessionHookWrapper({
      session,
      adapter,
    });
  }
}

/**
 * Session hook wrapper implementing AppaSessionHookInstance.
 * Encapsulates durable ledger mutations and runtime communication per turn.
 */
class AppaSessionHookWrapper implements AppaSessionHookInstance {
  readonly session: AppaProxyHookSession;
  readonly adapter: AppaClientAdapter;

  constructor(params: {
    session: AppaProxyHookSession;
    adapter: AppaClientAdapter;
  }) {
    this.session = params.session;
    this.adapter = params.adapter;
  }

  get sessionId(): string {
    return this.session.getNativeWireScope().sessionId;
  }

  get rootId(): string {
    return this.session.rootId;
  }

  async onPrompt(context: AppaPromptContext): Promise<void> {
    await this.session.sendPrompt(context.requestBody);
  }

  async onToolCalls(
    context: AppaToolCallsContext,
  ): Promise<AppaToolCallsDecision> {
    if (context.toolCalls.length === 0) {
      return { decision: "allow", calls: [] };
    }

    try {
      const outboundCalls: AppaOutboundToolCall[] = context.toolCalls.map(
        (tc: AppaToolCall) => {
          const rawArgs = JSON.stringify(tc.arguments);
          const targetName =
            this.adapter.canonicalizeLocalToolName?.(tc.name) ?? tc.name;
          return {
            id: tc.id,
            emittedName: tc.name,
            emittedArguments: rawArgs,
            emittedArgumentsCanonical: canonicalJsonObject(rawArgs),
            targetName,
            targetArguments: tc.arguments,
            spawn: tc.spawn ?? isAppaSpawnTool(tc.name),
          };
        },
      );

      const authorized =
        await this.session.authorizeOutboundToolCalls(outboundCalls);

      return {
        decision: "allow",
        calls: authorized.map((call) => ({
          id: call.id,
          name: call.targetName,
          arguments: call.targetArguments,
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

  async onToolResult(
    context: AppaToolResultContext,
  ): Promise<AppaToolResultOutcome> {
    const updates = this.session.getModelResultUpdates();
    return {
      status: "admitted",
      admittedResults: context.results,
      modelUpdates: updates,
    };
  }

  async onTurnEnd(_context: AppaTurnEndContext): Promise<void> {
    await this.session.finish();
  }

  async onChildStart(_context: AppaChildContext): Promise<void> {
    // Child start is automatically initiated during sendPrompt when parentClientSessionId is present
  }

  async onChildEnd(context: AppaChildContext): Promise<void> {
    await this.session.finish({
      childReturn:
        typeof context.result === "string"
          ? context.result
          : JSON.stringify(context.result),
    });
  }

  async abort(): Promise<void> {
    await this.session.abort();
  }
}
