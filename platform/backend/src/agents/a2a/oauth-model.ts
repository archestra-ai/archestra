import { a2aOAuthExecutionHeader } from "@/clients/a2a-oauth-execution";
import type { LLMModel } from "@/clients/llm-client";
import {
  type A2AOAuthExecution,
  authorizeA2AOAuthExecution,
} from "@/routes/mcp-gateway/utils";

export function authorizeA2AModel(params: {
  model: LLMModel;
  agentId: string;
  organizationId: string;
  execution?: A2AOAuthExecution;
}): LLMModel {
  const { model, execution, agentId, organizationId } = params;
  if (!execution) return model;
  if (typeof model === "string") {
    throw new Error("OAuth A2A execution requires a concrete provider model");
  }
  return new Proxy(model, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property !== "doGenerate" && property !== "doStream") return value;
      return async (options: {
        headers?: Record<string, string | undefined>;
      }) => {
        await authorizeA2AOAuthExecution({
          agentId,
          organizationId,
          execution,
        });
        return Reflect.apply(value, target, [
          {
            ...options,
            headers: {
              ...options.headers,
              ...a2aOAuthExecutionHeader(agentId, execution),
            },
          },
        ]);
      };
    },
  });
}
