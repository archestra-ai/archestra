import type { SupportedProvider } from "@archestra/shared/model-constants";
import logger from "@/logging";
import LlmThroughputModel, {
  type ThroughputReceipt,
} from "@/models/llm-throughput";
import type { LimitEntityType } from "@/types/limit";
import type { UsageView } from "@/types/llm-provider";

export class ThroughputError extends Error {
  interactionRecorded = false;
  readonly status: 400 | 402 | 429 | 503;
  readonly code: string;
  readonly quota?: {
    entityType: LimitEntityType;
    limitType: string;
    oversized: boolean;
    retryAfter: number | null;
  };
  constructor(params: {
    status: ThroughputError["status"];
    code: string;
    message: string;
    quota?: ThroughputError["quota"];
  }) {
    super(params.message);
    this.status = params.status;
    this.code = params.code;
    this.quota = params.quota;
  }
}

/** One instance per logical inference, shared by its internal provider retries. */
export class LlmThroughput {
  private reservation: ThroughputReceipt | null = null;
  private admitted = false;

  constructor(
    private readonly scope: {
      entities: Array<{ entityType: LimitEntityType; entityId: string }>;
      model: string;
      provider?: SupportedProvider;
      subscription?: boolean;
    },
  ) {}

  async admit(_request?: unknown): Promise<void> {
    if (this.admitted) return;
    try {
      const result = await LlmThroughputModel.admit(this.scope);
      if ("denied" in result) {
        throw new ThroughputError({
          status: result.denied.limitType === "token_cost" ? 402 : 429,
          code:
            result.denied.limitType === "token_cost"
              ? "token_cost_limit_exceeded"
              : "archestra_quota_exceeded",
          message:
            result.denied.limitType === "token_cost"
              ? "The gateway's spend limit is reached."
              : "The gateway's usage allowance is exhausted.",
          quota: result.denied,
        });
      }
      this.reservation = result.reservation;
      this.admitted = true;
    } catch (error) {
      if (error instanceof ThroughputError) throw error;
      logger.error({ err: error }, "Unable to admit LLM throughput");
      throw new ThroughputError({
        status: 503,
        code: "archestra_quota_storage_unavailable",
        message:
          "The gateway cannot verify its throughput quota. Try again later.",
      });
    }
  }

  async settleSpend(
    cost: string | number | null | undefined,
    billingMode?: "metered" | "subscription",
  ): Promise<void> {
    if (!this.reservation || cost == null) return;
    try {
      await LlmThroughputModel.reconcile({
        reservation: this.reservation,
        tokens: 0,
        spend: Number(cost),
        billingMode,
      });
    } catch (error) {
      logger.error({ err: error }, "Unable to settle minute spend");
      throw error;
    }
  }

  async cancelBeforeSend(): Promise<void> {
    if (!this.reservation) return;
    try {
      await LlmThroughputModel.reconcile({
        reservation: this.reservation,
        tokens: 0,
        cancelBeforeSend: true,
      });
    } catch (error) {
      logger.error(
        { err: error },
        "Unable to release unsent request allowance",
      );
    }
  }

  async reconcile(usage: UsageView | null | undefined): Promise<void> {
    if (!this.reservation || !usage) return;
    // This provider exposes only locally synthesized token metrics.
    if (this.scope.provider === "microsoft-365-copilot") return;
    // Cache-write 1h is a subset, never an additional charge. Gemini reports
    // thoughts separately from candidate output; OpenAI includes them already.
    const count = (item: UsageView) => {
      const values = [
        item.inputTokensEstimated ? 0 : item.inputTokens,
        item.outputTokensEstimated ? 0 : item.outputTokens,
        item.cacheReadTokens ?? 0,
        item.cacheWriteTokens ?? 0,
        this.scope.provider === "gemini" ? (item.reasoningTokens ?? 0) : 0,
      ];
      if (values.some((value) => !Number.isSafeInteger(value) || value < 0))
        return Number.NaN;
      return values.reduce((sum, value) => sum + value, 0);
    };
    const primary = count(usage);
    const components =
      usage.billingUsage?.components.reduce(
        (sum, item) => sum + count(item),
        0,
      ) ?? 0;
    // Complete iterations replace primary totals already represented in them.
    // For partial reports, count only the known, non-overlapping totals.
    const tokens =
      usage.billingUsage?.status === "complete"
        ? components
        : Math.max(primary, components);
    if (!Number.isSafeInteger(tokens)) return;
    try {
      await LlmThroughputModel.reconcile({
        reservation: this.reservation,
        tokens,
      });
    } catch (error) {
      logger.error({ err: error }, "Unable to record reported token usage");
      throw new ThroughputError({
        status: 503,
        code: "archestra_quota_storage_unavailable",
        message:
          "The gateway cannot record reported token usage. Try again later.",
      });
    }
  }
}
