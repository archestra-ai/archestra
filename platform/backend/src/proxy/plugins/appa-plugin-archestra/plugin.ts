import {
  checkToolCalls,
  type OpenAppaSession,
  processProxyResults,
} from "@/openappa/service";
import type {
  LlmProxyContextTrust,
  LlmProxyPlugin,
  LlmProxyRequestContext,
  LlmProxyToolCallsContext,
  LlmProxyToolCallsOutcome,
  LlmProxyToolResultsContext,
  LlmProxyToolResultsOutcome,
} from "@/proxy/plugins/registry";
import {
  APPA_PLUGIN_TRUSTED_CONTEXT,
  type AppaClientAdapter,
  type AppaTrustedContext,
} from "./types";

type AppaPluginBinding = {
  session: OpenAppaSession;
  canonicalizeToolName: (name: string) => string;
  adapter: AppaClientAdapter | undefined;
};

export class AppaPluginArchestra implements LlmProxyPlugin {
  readonly id = "archestra.appa";
  readonly finalizesToolCalls = true;
  private readonly bindings = new WeakMap<object, AppaPluginBinding>();

  constructor(private readonly clientAdapters: readonly AppaClientAdapter[]) {}

  async onSessionInit(context: LlmProxyRequestContext): Promise<void> {
    this.bindings.delete(context.resources);
    const trustedContext = getTrustedContext(context.resources);
    if (!trustedContext) return;
    // Other plugins share resources, but APPA's session and adapter selection do
    // not. Copy the host binding before any adapter receives it.
    const binding: AppaPluginBinding = {
      session: { ...trustedContext.session },
      canonicalizeToolName: trustedContext.canonicalizeToolName,
      adapter: undefined,
    };
    const adapter = this.clientAdapters.find((candidate) =>
      candidate.matches({
        headers: context.headers,
        requestBody: context.requestBody,
        trustedContext: cloneTrustedContext(trustedContext),
      }),
    );
    binding.adapter = adapter;
    // Unknown clients still get APPA enforcement using the proxy's canonical names.
    this.bindings.set(context.resources, binding);
  }

  async onToolResults(
    context: LlmProxyToolResultsContext,
  ): Promise<LlmProxyToolResultsOutcome | undefined> {
    const binding = this.bindings.get(context.resources);
    if (!binding) return;
    const result = await processProxyResults(binding.session, [
      ...context.toolResults,
    ]);
    return {
      toolResultUpdates: result.toolResultUpdates,
      contextTrust: {
        contextIsTrusted: result.contextIsTrusted,
        dualLlmAnalyses: result.dualLlmAnalyses,
        unsafeContextBoundary: result.unsafeContextBoundary,
      } satisfies LlmProxyContextTrust,
    };
  }

  async onToolCalls(
    context: LlmProxyToolCallsContext,
  ): Promise<LlmProxyToolCallsOutcome | undefined> {
    const binding = this.bindings.get(context.resources);
    if (!binding) return;
    const refusal = await checkToolCalls(
      binding.session,
      [...context.toolCalls],
      (name) =>
        binding.adapter?.classifyToolName(name) === "local"
          ? binding.canonicalizeToolName(
              binding.adapter.normalizeLocalToolName(name),
            )
          : binding.canonicalizeToolName(name),
    );
    if (!refusal) return;
    return { decision: "refuse", refusal };
  }

  async onCleanup(context: LlmProxyRequestContext): Promise<void> {
    this.bindings.delete(context.resources);
  }
}

function getTrustedContext(
  resources: ReadonlyMap<PropertyKey, unknown>,
): AppaTrustedContext | undefined {
  const trustedContext = resources.get(APPA_PLUGIN_TRUSTED_CONTEXT);
  return typeof trustedContext === "object" &&
    trustedContext !== null &&
    "session" in trustedContext &&
    "profileId" in trustedContext &&
    "canonicalizeToolName" in trustedContext
    ? (trustedContext as AppaTrustedContext)
    : undefined;
}

function cloneTrustedContext(context: AppaTrustedContext): AppaTrustedContext {
  return {
    ...context,
    session: { ...context.session },
  };
}
