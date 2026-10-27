import type { CubeRow, PivotQuery } from "./cost-explorer-data";

export function getCostLimitsLabel(
  query: Pick<PivotQuery, "metric" | "group">,
  selected?: Pick<CubeRow, "label">,
) {
  const kind =
    query.metric === "billed"
      ? "spend"
      : query.metric === "tokens"
        ? "token"
        : "request";
  if (selected) return `Show ${kind} limits for ${selected.label}`;
  const scope =
    query.group === "team"
      ? "team "
      : query.group === "agent"
        ? "agent "
        : query.group === "person"
          ? "user "
          : query.group === "key"
            ? "virtual key "
            : "";
  return `Show ${scope}${kind} limits`;
}

/** Carry only an unambiguous, supported limit scope into the Limits page. */
export function getCostLimitsLink(
  query: Pick<PivotQuery, "metric" | "group">,
  selected?: Pick<CubeRow, "key" | "limitTarget">,
) {
  const kind =
    query.metric === "billed"
      ? "token_cost"
      : query.metric === "tokens" || query.metric === "requests"
        ? query.metric
        : null;
  if (!kind) return null;
  const params = new URLSearchParams({ units: kind });
  if (query.group === "model") {
    if (selected) params.set("model", selected.key);
  } else {
    const entityType =
      query.group === "team"
        ? "team"
        : query.group === "key"
          ? "virtual_key"
          : kind === "token_cost" && query.group === "agent"
            ? "agent"
            : kind === "token_cost" && query.group === "person"
              ? "user"
              : null;
    if (!entityType) return null;
    params.set("appliedTo", entityType);
    if (selected) {
      if (query.group === "key") {
        if (!selected.limitTarget) return null;
        params.set("entityId", selected.limitTarget.entityId);
      } else {
        params.set("entityId", selected.key);
      }
    }
  }
  return `/llm/limits?${params.toString()}`;
}
