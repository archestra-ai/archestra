/** Public extension contract for cross-cutting LLM proxy behavior. */
export type LlmProxyRequestContext = {
  requestId: string;
  organizationId: string;
  profileId: string;
  provider: string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  requestBody: unknown;
  resources: Map<string, unknown>;
};

export type LlmProxyToolCall = {
  id: string;
  name: string;
  arguments: string | Record<string, unknown>;
};

export type LlmProxyToolResult = {
  id: string;
  content: unknown;
  isError?: boolean;
};

export type LlmProxyToolCallsOutcome =
  | { decision: "allow" }
  | { decision: "refuse"; message: string };

export interface LlmProxyPlugin {
  readonly id: string;
  onSessionInit?(context: LlmProxyRequestContext): Promise<void>;
  onToolCalls?(
    context: LlmProxyRequestContext & {
      toolCalls: readonly LlmProxyToolCall[];
    },
  ): Promise<LlmProxyToolCallsOutcome | undefined>;
  onToolResults?(
    context: LlmProxyRequestContext & {
      toolResults: readonly LlmProxyToolResult[];
    },
  ): Promise<void>;
}

/** Ordered registry for proxy lifecycle extensions. */
export class LlmProxyPluginRegistry {
  private readonly plugins: LlmProxyPlugin[] = [];

  register(plugin: LlmProxyPlugin): () => void {
    if (this.plugins.some((candidate) => candidate.id === plugin.id)) {
      throw new Error(`LLM proxy plugin ${plugin.id} is already registered`);
    }
    this.plugins.push(plugin);
    return () => {
      const index = this.plugins.indexOf(plugin);
      if (index >= 0) this.plugins.splice(index, 1);
    };
  }

  async onSessionInit(context: LlmProxyRequestContext): Promise<void> {
    for (const plugin of this.plugins) await plugin.onSessionInit?.(context);
  }

  async onToolCalls(
    context: LlmProxyRequestContext & {
      toolCalls: readonly LlmProxyToolCall[];
    },
  ): Promise<LlmProxyToolCallsOutcome> {
    for (const plugin of this.plugins) {
      const outcome = await plugin.onToolCalls?.(context);
      if (outcome?.decision === "refuse") return outcome;
    }
    return { decision: "allow" };
  }

  async onToolResults(
    context: LlmProxyRequestContext & {
      toolResults: readonly LlmProxyToolResult[];
    },
  ): Promise<void> {
    for (const plugin of this.plugins) await plugin.onToolResults?.(context);
  }
}

const defaultLlmProxyPluginRegistry = new LlmProxyPluginRegistry();

/** Registers a plugin for every LLM proxy request in this process. */
export function registerLlmProxyPlugin(plugin: LlmProxyPlugin): () => void {
  return defaultLlmProxyPluginRegistry.register(plugin);
}

/** Returns the proxy's process-wide plugin registry. */
export function getLlmProxyPluginRegistry(): LlmProxyPluginRegistry {
  return defaultLlmProxyPluginRegistry;
}
