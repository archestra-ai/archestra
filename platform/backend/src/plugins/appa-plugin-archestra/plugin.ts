import type { PolicyBlockResult } from "@/guardrails/tool-invocation";
import {
  checkToolCalls,
  type OpenAppaSession,
  processProxyResults,
} from "@/openappa/service";
import type {
  LlmProxyPlugin,
  LlmProxyRequestContext,
} from "@/plugins/llm-proxy-plugin";
import type { CommonToolResult } from "@/types";
import type { AppaClientAdapter } from "./types";

export const APPA_PLUGIN_BINDING = "archestra.appa.binding";
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

  getClientAdapter(
    context: LlmProxyRequestContext,
  ): AppaClientAdapter | undefined {
    return this.clientAdapters.find((adapter) => adapter.matches(context));
  }

  async onSessionInit(context: LlmProxyRequestContext): Promise<void> {
    const adapter = this.getClientAdapter(context);
    if (adapter) {
      context.resources.set(`${this.id}.adapter`, adapter);
      const sessionId = adapter.getNativeSessionId(context);
      if (sessionId)
        context.resources.set(`${this.id}.native-session-id`, sessionId);
    }
  }

  async onToolResults(
    context: LlmProxyRequestContext & {
      toolResults: readonly CommonToolResult[];
    },
  ) {
    const binding = getBinding(context.resources);
    if (!binding) return;
    const result = await processProxyResults(binding.session, [
      ...context.toolResults,
    ]);
    context.resources.set(APPA_PLUGIN_RESULT, result);
    return { toolResultUpdates: result.toolResultUpdates };
  }

  async onToolCalls(
    context: LlmProxyRequestContext & {
      toolCalls: readonly {
        id: string;
        name: string;
        arguments: string | Record<string, unknown>;
      }[];
    },
  ) {
    const binding = getBinding(context.resources);
    if (!binding) return;
    const adapter = context.resources.get(`${this.id}.adapter`) as
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
