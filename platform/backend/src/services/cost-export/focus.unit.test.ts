import { describe, expect, test } from "vitest";
import type { CostExportUsageRow } from "@/types/cost-export";
import { buildFocusCsv } from "./focus";

describe("buildFocusCsv", () => {
  test("writes only the header for a period without usage", () => {
    const csv = buildFocusCsv({ organization: ORGANIZATION, rows: [] });

    expect(csv.split("\r\n")).toEqual([
      expect.stringMatching(/^BilledCost,/),
      "",
    ]);
  });

  test("quotes names holding commas, quotes or line breaks", () => {
    const csv = buildFocusCsv({
      organization: { id: "org-1", name: 'Acme, "Inc"' },
      rows: [row({ agentName: "Bot,\nOne" })],
    });

    expect(csv).toContain('"Acme, ""Inc"""');
    expect(csv).toContain('"Bot,\nOne"');
  });

  test("bills subscription usage at zero and keeps its list price", () => {
    const [header, line] = buildFocusCsv({
      organization: ORGANIZATION,
      rows: [row({ billingMode: "subscription", cost: "1.2500" })],
    }).split("\r\n");
    const record = Object.fromEntries(
      header.split(",").map((name, i) => [name, line.split(",")[i]]),
    );

    expect(record).toMatchObject({
      BilledCost: "0",
      EffectiveCost: "0",
      ListCost: "1.25",
      PricingCategory: "Other",
      BillingPeriodStart: "2026-11-01T00:00:00Z",
      BillingPeriodEnd: "2026-12-01T00:00:00Z",
    });
  });

  test("names an unknown provider API by its own identifier", () => {
    const csv = buildFocusCsv({
      organization: ORGANIZATION,
      rows: [row({ provider: "acme-llm:chat" })],
    });

    expect(csv).toContain(",acme-llm API,");
  });
});

const ORGANIZATION = { id: "org-1", name: "Org" };

function row(overrides: Partial<CostExportUsageRow>): CostExportUsageRow {
  return {
    hour: "2026-11-10 13:00:00",
    provider: "openai:chatCompletions",
    model: "gpt-test",
    billingMode: "metered",
    teamId: null,
    teamName: null,
    agentId: "agent-1",
    agentName: "Agent",
    agentType: "llm_proxy",
    appId: null,
    appName: null,
    connectorId: null,
    connectorName: null,
    userId: null,
    userEmail: null,
    requests: "1",
    inputTokens: "10",
    outputTokens: "5",
    cacheReadTokens: "0",
    cacheWriteTokens: "0",
    cost: "0.01",
    ...overrides,
  };
}
