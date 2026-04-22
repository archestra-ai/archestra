import type { MemoryItem } from "@/types/memory-item";

export type ApplyBudgetParams = {
  items: MemoryItem[];
  maxTokens: number;
  topK: number;
};

export type ApplyBudgetResult = {
  items: MemoryItem[];
  totalTokensApprox: number;
  droppedByTopK: number;
  droppedByBudget: number;
};

export function applyBudget(params: ApplyBudgetParams): ApplyBudgetResult {
  const topK = normalizePositiveInt(params.topK);
  const maxTokens = normalizePositiveInt(params.maxTokens);

  if (topK === 0 || maxTokens === 0 || params.items.length === 0) {
    return {
      items: [],
      totalTokensApprox: 0,
      droppedByTopK: params.items.length,
      droppedByBudget: 0,
    };
  }

  const candidateItems = params.items.slice(0, topK);
  const selectedItems: MemoryItem[] = [];
  let totalTokensApprox = 0;
  let droppedByBudget = 0;

  for (let index = 0; index < candidateItems.length; index += 1) {
    const item = candidateItems[index];
    const itemTokensApprox = estimateMemoryItemTokens(item);

    if (itemTokensApprox > maxTokens) {
      droppedByBudget += 1;
      continue;
    }

    if (totalTokensApprox + itemTokensApprox > maxTokens) {
      droppedByBudget += candidateItems.length - index;
      break;
    }

    selectedItems.push(item);
    totalTokensApprox += itemTokensApprox;
  }

  return {
    items: selectedItems,
    totalTokensApprox,
    droppedByTopK: Math.max(0, params.items.length - candidateItems.length),
    droppedByBudget,
  };
}

export function estimateTokenCount(content: string): number {
  const normalizedLength = content.trim().length;

  if (normalizedLength === 0) {
    return 0;
  }

  return Math.ceil(normalizedLength / 4);
}

// ============================================================================
// Internal helpers
// ============================================================================

function estimateMemoryItemTokens(item: MemoryItem): number {
  return estimateTokenCount(`[${item.kind}] ${item.content}`);
}

function normalizePositiveInt(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.floor(value));
}
