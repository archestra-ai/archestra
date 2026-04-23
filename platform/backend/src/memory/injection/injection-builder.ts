import { context, type Span, trace } from "@opentelemetry/api";
import config from "@/config";
import logger from "@/logging";
import { listForInjection } from "@/memory/retrieval/retrieval-service";
import { reportMemoryInjectionTokens } from "@/memory/telemetry/metrics";
import {
  setMemorySpanAttributes,
  withMemorySpan,
} from "@/memory/telemetry/spans";
import type { MemoryItem } from "@/types/memory-item";
import { applyBudget } from "./injection-budget";

export type BuildInjectionParams = {
  userId: string;
  organizationId: string;
  teamIds?: string[];
  enabled: boolean;
};

export async function build(
  params: BuildInjectionParams,
): Promise<string | null> {
  const parentSpan = trace.getSpan(context.active());

  return withMemorySpan(
    "inject",
    async (memorySpan) => {
      setMemorySpanAttributes(memorySpan, {
        scopeType: "user",
        scopeId: params.userId,
      });

      if (params.enabled === false) {
        logger.info(
          {
            userId: params.userId,
            organizationId: params.organizationId,
          },
          "[memory] injection: skipped",
        );
        setInjectionSpanAttributes(
          {
            injectedCount: 0,
            injectedTokensApprox: 0,
          },
          parentSpan,
        );
        setMemorySpanAttributes(memorySpan, {
          injectedCount: 0,
          injectedTokensApprox: 0,
        });
        reportMemoryInjectionTokens({
          scopeType: "user",
          tokensApprox: 0,
        });
        return null;
      }

      try {
        const topK = config.memory.injectionTopK;
        const memoryCandidates = await withMemorySpan(
          "retrieve",
          async () => {
            return listForInjection({
              userId: params.userId,
              organizationId: params.organizationId,
              teamIds: params.teamIds ?? [],
              scopesEnabled: ["user"], // Rollout-1 hard limit.
            });
          },
          {
            scopeType: "user",
            scopeId: params.userId,
          },
        );

        const budgetResult = applyBudget({
          items: memoryCandidates,
          maxTokens: config.memory.injectionTokenBudget,
          topK,
        });

        setInjectionSpanAttributes(
          {
            injectedCount: budgetResult.items.length,
            injectedTokensApprox: budgetResult.totalTokensApprox,
          },
          parentSpan,
        );
        setMemorySpanAttributes(memorySpan, {
          injectedCount: budgetResult.items.length,
          injectedTokensApprox: budgetResult.totalTokensApprox,
        });
        reportMemoryInjectionTokens({
          scopeType: "user",
          tokensApprox: budgetResult.totalTokensApprox,
        });

        if (budgetResult.items.length === 0) {
          return null;
        }

        return renderMemoryBlock(budgetResult.items);
      } catch (error) {
        logger.warn(
          {
            error: error instanceof Error ? error.message : String(error),
            userId: params.userId,
            organizationId: params.organizationId,
          },
          "[memory] injection: failed, continuing without memory context",
        );

        setInjectionSpanAttributes(
          {
            injectedCount: 0,
            injectedTokensApprox: 0,
          },
          parentSpan,
        );
        setMemorySpanAttributes(memorySpan, {
          injectedCount: 0,
          injectedTokensApprox: 0,
        });
        reportMemoryInjectionTokens({
          scopeType: "user",
          tokensApprox: 0,
        });
        return null;
      }
    },
    {
      scopeType: "user",
      scopeId: params.userId,
    },
  );
}

export const memoryInjectionBuilder = {
  build,
};

// ============================================================================
// Internal helpers
// ============================================================================

function renderMemoryBlock(items: MemoryItem[]): string {
  const lines = items.map(
    (item) => `  - [${item.kind}] ${normalizeContent(item.content)}`,
  );

  return [
    "<durable_memory>",
    "- Approved user memory (use only if directly relevant):",
    ...lines,
    "</durable_memory>",
  ].join("\n");
}

function normalizeContent(content: string): string {
  return content.replace(/\s+/g, " ").trim();
}

function setInjectionSpanAttributes(
  params: {
    injectedCount: number;
    injectedTokensApprox: number;
  },
  targetSpan?: Span | null,
): void {
  const span = targetSpan ?? trace.getSpan(context.active());
  if (!span) {
    return;
  }

  span.setAttribute("archestra.memory.injected_count", params.injectedCount);
  span.setAttribute(
    "archestra.memory.injected_tokens_approx",
    params.injectedTokensApprox,
  );
}
