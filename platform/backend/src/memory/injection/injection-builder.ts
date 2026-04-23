import { context, trace } from "@opentelemetry/api";
import config from "@/config";
import logger from "@/logging";
import { listForInjection } from "@/memory/retrieval/retrieval-service";
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
  if (params.enabled === false) {
    setInjectionSpanAttributes({
      injectedCount: 0,
      injectedTokensApprox: 0,
    });
    return null;
  }

  try {
    const topK = config.memory.injectionTopK;
    const memoryCandidates = await listForInjection({
      userId: params.userId,
      organizationId: params.organizationId,
      teamIds: params.teamIds ?? [],
      scopesEnabled: ["user"], // Rollout-1 hard limit.
    });

    const budgetResult = applyBudget({
      items: memoryCandidates,
      maxTokens: config.memory.injectionTokenBudget,
      topK,
    });

    setInjectionSpanAttributes({
      injectedCount: budgetResult.items.length,
      injectedTokensApprox: budgetResult.totalTokensApprox,
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
      "Memory injection build failed; continuing without memory context",
    );

    setInjectionSpanAttributes({
      injectedCount: 0,
      injectedTokensApprox: 0,
    });
    return null;
  }
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

function setInjectionSpanAttributes(params: {
  injectedCount: number;
  injectedTokensApprox: number;
}): void {
  const activeSpan = trace.getSpan(context.active());
  if (!activeSpan) {
    return;
  }

  activeSpan.setAttribute(
    "archestra.memory.injected_count",
    params.injectedCount,
  );
  activeSpan.setAttribute(
    "archestra.memory.injected_tokens_approx",
    params.injectedTokensApprox,
  );
}
