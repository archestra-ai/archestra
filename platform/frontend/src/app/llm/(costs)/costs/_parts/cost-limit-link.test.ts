// @vitest-environment node
import { describe, expect, it } from "vitest";
import { getCostLimitsLabel, getCostLimitsLink } from "./cost-limit-link";

describe("Costs to Limits context", () => {
  it("names the exact kind and selected row rather than a broad View limits action", () => {
    expect(
      getCostLimitsLabel(
        { metric: "tokens", group: "model" },
        { label: "Selected model" },
      ),
    ).toBe("Show token limits for Selected model");
    expect(
      getCostLimitsLabel(
        { metric: "billed", group: "team" },
        { label: "Engineering" },
      ),
    ).toBe("Show spend limits for Engineering");
    expect(getCostLimitsLabel({ metric: "requests", group: "key" })).toBe(
      "Show virtual key request limits",
    );
    expect(getCostLimitsLabel({ metric: "billed", group: "model" })).toBe(
      "Show spend limits",
    );
  });
  it("encodes the selected model and kind without carrying the historical range", () => {
    const url = new URL(
      getCostLimitsLink(
        { metric: "tokens", group: "model" },
        { key: "vendor/model+v2" },
      ) ?? "",
      "http://localhost",
    );
    expect(url.pathname).toBe("/llm/limits");
    expect(url.searchParams.get("units")).toBe("tokens");
    expect(url.searchParams.get("model")).toBe("vendor/model+v2");
    expect(url.searchParams.has("timeframe")).toBe(false);
  });

  it.each([
    ["team", "tokens", "team"],
    ["team", "requests", "team"],
    ["agent", "billed", "agent"],
    ["person", "billed", "user"],
  ] as const)("keeps the exact selected %s scope for %s", (group, metric, appliedTo) => {
    const url = new URL(
      getCostLimitsLink({ group, metric }, { key: "entity-123" }) ?? "",
      "http://localhost",
    );
    expect(url.searchParams.get("appliedTo")).toBe(appliedTo);
    expect(url.searchParams.get("entityId")).toBe("entity-123");
  });

  it("links only identifiable virtual keys, not arbitrary provider-key rows", () => {
    const q = { group: "key", metric: "requests" } as const;
    expect(getCostLimitsLink(q, { key: "provider-key" })).toBeNull();
    const url = new URL(
      getCostLimitsLink(q, {
        key: "key-123",
        limitTarget: { entityType: "virtual_key", entityId: "key-123" },
      }) ?? "",
      "http://localhost",
    );
    expect(url.searchParams.get("appliedTo")).toBe("virtual_key");
    expect(url.searchParams.get("entityId")).toBe("key-123");
  });

  it.each([
    ["subscription", "model"],
    ["toolCalls", "server"],
    ["tokens", "skill"],
    ["billed", "app"],
    ["requests", "person"],
    ["tokens", "agent"],
  ] as const)("does not imply a %s limit exists for the %s grouping", (metric, group) => {
    expect(
      getCostLimitsLink({ metric, group }, { key: "unsupported" }),
    ).toBeNull();
  });

  it("keeps a generic kind/group link without an unambiguous row selection", () => {
    const url = new URL(
      getCostLimitsLink({ metric: "billed", group: "team" }) ?? "",
      "http://localhost",
    );
    expect(url.searchParams.get("units")).toBe("token_cost");
    expect(url.searchParams.get("appliedTo")).toBe("team");
    expect(url.searchParams.has("entityId")).toBe(false);
  });
});
