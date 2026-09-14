import type { PolicyBlockResult } from "@/guardrails/tool-invocation";
import {
  checkToolCalls,
  processProxyResults,
  type OpenAppaSession,
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

export type AppaPluginBinding = {
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
    if (adapter) context.resources.set(`${this.id}.adapter`, adapter);
  }

  async onToolResults(
    context: LlmProxyRequestContext & {
      toolResults: readonly CommonToolResult[];
    },
  ): Promise<void> {
    const binding = getBinding(context.resources);
    if (!binding) return;
    context.resources.set(
      APPA_PLUGIN_RESULT,
      await processProxyResults(binding.session, [...context.toolResults]),
    );
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
    const refusal = await checkToolCalls(
      binding.session,
      [...context.toolCalls],
      binding.canonicalizeToolName,
    );
    if (!refusal) return { decision: "allow" as const };
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
