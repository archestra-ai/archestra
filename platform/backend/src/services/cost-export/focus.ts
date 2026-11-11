import {
  isSupportedProvider,
  providerDisplayNames,
  type SupportedProvider,
} from "@archestra/shared/model-constants";
import type { CostExportUsageRow } from "@/types/cost-export";

/**
 * FOCUS 1.2 (FinOps Open Cost and Usage Specification) rows of LLM usage, so
 * Archestra spend lands in the same FinOps tooling as cloud bills.
 *
 * One row per hour and charge (provider, billed model, billing mode, team,
 * agent and user). Archestra does not invoice LLM usage: the provider does, so
 * the provider is the row's `ProviderName`, `PublisherName` and
 * `InvoiceIssuerName`, and the Archestra organization is the billing account.
 * `ListCost` is the price-list estimate Archestra records for every request;
 * `BilledCost` and `EffectiveCost` are zero for subscription traffic (Claude
 * Pro/Max, ChatGPT plans), which the provider does not bill per token.
 * Archestra-specific detail is in `x_`-prefixed columns, as the spec reserves
 * for custom columns.
 */
export function buildFocusCsv(params: {
  organization: { id: string; name: string };
  rows: CostExportUsageRow[];
}): string {
  const lines = [FOCUS_COLUMNS.join(",")];
  for (const row of params.rows) {
    const record = focusRecord(params.organization, row);
    lines.push(
      FOCUS_COLUMNS.map((column) => csvField(record[column])).join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

// === internal ===

const FOCUS_COLUMNS = [
  "BilledCost",
  "BillingAccountId",
  "BillingAccountName",
  "BillingAccountType",
  "BillingCurrency",
  "BillingPeriodEnd",
  "BillingPeriodStart",
  "ChargeCategory",
  "ChargeClass",
  "ChargeDescription",
  "ChargeFrequency",
  "ChargePeriodEnd",
  "ChargePeriodStart",
  "ConsumedQuantity",
  "ConsumedUnit",
  "ContractedCost",
  "ContractedUnitPrice",
  "EffectiveCost",
  "InvoiceIssuerName",
  "ListCost",
  "ListUnitPrice",
  "PricingCategory",
  "PricingCurrency",
  "PricingQuantity",
  "PricingUnit",
  "ProviderName",
  "PublisherName",
  "RegionId",
  "RegionName",
  "ResourceId",
  "ResourceName",
  "ResourceType",
  "ServiceCategory",
  "ServiceName",
  "ServiceSubcategory",
  "SkuId",
  "SkuPriceId",
  "SubAccountId",
  "SubAccountName",
  "SubAccountType",
  "Tags",
  "x_BillingMode",
  "x_CacheReadTokens",
  "x_CacheWriteTokens",
  "x_InputTokens",
  "x_OutputTokens",
  "x_ProviderApi",
  "x_Requests",
  "x_UserEmail",
  "x_UserId",
] as const;

type FocusColumn = (typeof FOCUS_COLUMNS)[number];

function focusRecord(
  organization: { id: string; name: string },
  row: CostExportUsageRow,
): Record<FocusColumn, string | null> {
  const chargeStart = utcTimestamp(row.hour);
  const chargeEnd = new Date(chargeStart.getTime() + HOUR_MS);
  const billingStart = new Date(
    Date.UTC(chargeStart.getUTCFullYear(), chargeStart.getUTCMonth(), 1),
  );
  const billingEnd = new Date(
    Date.UTC(chargeStart.getUTCFullYear(), chargeStart.getUTCMonth() + 1, 1),
  );
  const provider = providerName(row.provider);
  const model = row.model ?? "unknown";
  const cost = decimal(row.cost);
  const billed = row.billingMode === "subscription" ? "0" : cost;
  const tokens = (
    BigInt(row.inputTokens) + BigInt(row.outputTokens)
  ).toString();
  const resource = resourceOf(row);
  const tags: Record<string, string> = {
    "archestra:billing-mode": row.billingMode,
    "archestra:provider-api": row.provider,
  };
  if (row.teamName) tags["archestra:team"] = row.teamName;
  if (row.userEmail) tags["archestra:user"] = row.userEmail;
  if (resource.name) tags["archestra:resource"] = resource.name;

  return {
    BilledCost: billed,
    BillingAccountId: organization.id,
    BillingAccountName: organization.name,
    BillingAccountType: "Archestra Organization",
    BillingCurrency: CURRENCY,
    BillingPeriodEnd: isoTimestamp(billingEnd),
    BillingPeriodStart: isoTimestamp(billingStart),
    ChargeCategory: "Usage",
    ChargeClass: null,
    ChargeDescription: `${row.requests} request(s) to ${model} via ${provider}`,
    ChargeFrequency: "Usage-Based",
    ChargePeriodEnd: isoTimestamp(chargeEnd),
    ChargePeriodStart: isoTimestamp(chargeStart),
    ConsumedQuantity: tokens,
    ConsumedUnit: "Tokens",
    ContractedCost: cost,
    ContractedUnitPrice: null,
    EffectiveCost: billed,
    InvoiceIssuerName: provider,
    ListCost: cost,
    ListUnitPrice: null,
    PricingCategory: row.billingMode === "subscription" ? "Other" : "Standard",
    PricingCurrency: CURRENCY,
    PricingQuantity: tokens,
    PricingUnit: "Tokens",
    ProviderName: provider,
    PublisherName: provider,
    RegionId: null,
    RegionName: null,
    ResourceId: resource.id,
    ResourceName: resource.name,
    ResourceType: resource.type,
    ServiceCategory: "AI and Machine Learning",
    ServiceName: `${provider} API`,
    ServiceSubcategory: "Generative AI",
    SkuId: model,
    SkuPriceId: null,
    SubAccountId: row.teamId,
    SubAccountName: row.teamName,
    SubAccountType: row.teamId ? "Team" : null,
    Tags: JSON.stringify(tags),
    x_BillingMode: row.billingMode,
    x_CacheReadTokens: row.cacheReadTokens,
    x_CacheWriteTokens: row.cacheWriteTokens,
    x_InputTokens: row.inputTokens,
    x_OutputTokens: row.outputTokens,
    x_ProviderApi: row.provider,
    x_Requests: row.requests,
    x_UserEmail: row.userEmail,
    x_UserId: row.userId,
  };
}

/**
 * The vendor that serves and invoices the traffic, under its own name: an
 * export names who bills you, so an admin's display rename does not apply.
 */
function providerName(discriminator: string): string {
  const provider = discriminator.split(":")[0];
  // A local alias: the shipped name is the point here (see the
  // integration-labels-via-catalog lint rule).
  const vendorNames: Record<SupportedProvider, string> = providerDisplayNames;
  return isSupportedProvider(provider) ? vendorNames[provider] : provider;
}

function resourceOf(row: CostExportUsageRow): {
  id: string | null;
  name: string | null;
  type: string | null;
} {
  if (row.agentId) {
    return {
      id: row.agentId,
      name: row.agentName,
      type: AGENT_TYPE_LABELS[row.agentType ?? ""] ?? "Agent",
    };
  }
  if (row.appId) return { id: row.appId, name: row.appName, type: "App" };
  if (row.connectorId) {
    return {
      id: row.connectorId,
      name: row.connectorName,
      type: "Knowledge Connector",
    };
  }
  return { id: null, name: null, type: null };
}

/** A `timestamp` column's text (UTC wall-clock time) as a Date. */
function utcTimestamp(value: string): Date {
  return new Date(`${value.replace(" ", "T")}Z`);
}

/** ISO 8601 in UTC without milliseconds, as FOCUS date/time columns use. */
function isoTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** A PostgreSQL numeric's text without trailing fractional zeros. */
function decimal(value: string): string {
  return value.includes(".") ? value.replace(/\.?0+$/, "") || "0" : value;
}

/** RFC 4180 field: quoted when it holds a comma, quote or line break. */
function csvField(value: string | null): string {
  if (value === null) return "";
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

const HOUR_MS = 60 * 60 * 1000;
const CURRENCY = "USD";
const AGENT_TYPE_LABELS: Record<string, string> = {
  agent: "Agent",
  llm_proxy: "LLM Proxy",
  mcp_gateway: "MCP Gateway",
  profile: "Agent",
};
