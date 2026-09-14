import type { PolicyBlockResult } from "@/guardrails/tool-invocation";
import {
  checkToolCalls,
  type OpenAppaSession,
  processProxyResults,
} from "@/openappa/service";
import type {
  LlmProxyPlugin,
  LlmProxyRequestContext,
  LlmProxyToolCallsContext,
  LlmProxyToolCallsOutcome,
  LlmProxyToolResultsContext,
  LlmProxyToolResultsOutcome,
} from "@/proxy/plugins/registry";
import type { AppaClientAdapter, AppaTrustedContext } from "./types";

const APPA_PLUGIN_BINDING = "archestra.appa.binding";
export const APPA_PLUGIN_TRUSTED_CONTEXT = "archestra.appa.trusted-context";
const APPA_PLUGIN_ADAPTER = "archestra.appa.adapter";
const APPA_PLUGIN_RESULT = "archestra.appa.result";
const APPA_PLUGIN_REFUSAL = "archestra.appa.refusal";

type AppaPluginBinding = {
  session: OpenAppaSession;
  canonicalizeToolName: (name: string) => string;
};

type AppaPluginResult = Awaited<ReturnType<typeof processProxyResults>>;

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
    context.resources.set(APPA_PLUGIN_RESULT, result);
    return { toolResultUpdates: result.toolResultUpdates };
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
    context.resources.set(APPA_PLUGIN_REFUSAL, refusal);
    return { decision: "refuse" as const, message: refusal.refusalMessage };
  }
}

export function getAppaPluginResult(
  resources: ReadonlyMap<string, unknown>,
): AppaPluginResult | undefined {
  return resources.get(APPA_PLUGIN_RESULT) as AppaPluginResult | undefined;
}

export function getAppaPluginRefusal(
  resources: ReadonlyMap<string, unknown>,
): PolicyBlockResult | undefined {
  return resources.get(APPA_PLUGIN_REFUSAL) as PolicyBlockResult | undefined;
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
