import {
  LIMIT_MODELS_HEADER,
  LIMIT_RESETS_AT_HEADER,
  LIMIT_SCOPE_HEADER,
  LIMIT_VALUE_HEADER,
} from "@shared";
import type { LimitInfo } from "@/types";

export function setLimitHeaders(
  target: { header: (key: string, value: string) => unknown },
  limitInfo: LimitInfo | null,
): void {
  if (!limitInfo) return;
  target.header(LIMIT_VALUE_HEADER, limitInfo.limitValue.toFixed(2));
  target.header(LIMIT_RESETS_AT_HEADER, limitInfo.resetsAt);
  target.header(LIMIT_SCOPE_HEADER, limitInfo.scope);
  const models = limitInfo.models;
  target.header(
    LIMIT_MODELS_HEADER,
    models && models.length > 0 ? models.join(",") : "all",
  );
}
