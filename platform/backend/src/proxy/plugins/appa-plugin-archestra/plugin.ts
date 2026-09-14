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

const APPA_PLUGIN_BINDING = "archestra.appa.binding";
const APPA_PLUGIN_ADAPTER = "archestra.appa.adapter";

type AppaPluginBinding = {
  session: OpenAppaSession;
  canonicalizeToolName: (name: string) => string;
};

export class AppaPluginArchestra implements LlmProxyPlugin {
  readonly id = "archestra.appa";

  constructor(private readonly clientAdapters: readonly AppaClientAdapter[]) {}

  async onSessionInit(context: LlmProxyRequestContext): Promise<void> {
    const trustedContext = getTrustedContext(context.resources);
    if (!trustedContext) return;
    const adapter = this.clientAdapters.find((candidate) =>
      candidate.matches({ ...context, trustedContext }),
    );
    if (adapter) {
      context.resources.set(APPA_PLUGIN_ADAPTER, adapter);
    }
    context.resources.set(APPA_PLUGIN_BINDING, {
      session: trustedContext.session,
      canonicalizeToolName: trustedContext.canonicalizeToolName,
    } satisfies AppaPluginBinding);
  }

  async onToolResults(
    context: LlmProxyToolResultsContext,
  ): Promise<LlmProxyToolResultsOutcome | undefined> {
    const binding = getBinding(context.resources);
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
    const binding = getBinding(context.resources);
    if (!binding) return;
    const adapter = context.resources.get(APPA_PLUGIN_ADAPTER) as
      | AppaClientAdapter
      | undefined;
    const refusal = await checkToolCalls(
      binding.session,
      [...context.toolCalls],
      (name) =>
        adapter?.classifyToolName(name) === "local"
          ? binding.canonicalizeToolName(adapter.normalizeLocalToolName(name))
          : binding.canonicalizeToolName(name),
    );
    if (!refusal) return;
    return { decision: "refuse", refusal };
  }
}

function getBinding(
  resources: ReadonlyMap<string, unknown>,
): AppaPluginBinding | undefined {
  const binding = resources.get(APPA_PLUGIN_BINDING);
  return typeof binding === "object" &&
    binding !== null &&
    "session" in binding &&
    "canonicalizeToolName" in binding
    ? (binding as AppaPluginBinding)
    : undefined;
}

function getTrustedContext(
  resources: ReadonlyMap<string, unknown>,
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
