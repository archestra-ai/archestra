import type { UsageView } from "@/types/llm-provider";

/** A failed upstream call that already reported potentially billable work. */
export class ObservedProviderUsageError extends Error {
  readonly status = 502;
  readonly billingRecorded: boolean;
  readonly original: unknown;
  readonly usage: UsageView;
  readonly response: unknown;
  constructor(params: {
    original: unknown;
    usage: UsageView;
    response: unknown;
    billingRecorded?: boolean;
  }) {
    super(
      params.original instanceof Error
        ? params.original.message
        : "Provider generation failed after reporting usage",
      { cause: params.original },
    );
    this.original = params.original;
    this.usage = params.usage;
    this.response = params.response;
    this.billingRecorded = params.billingRecorded ?? false;
  }
}
