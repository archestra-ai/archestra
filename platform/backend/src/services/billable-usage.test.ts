import { expect, test } from "vitest";
import ModelModel from "@/models/model";
import { normalizeAnthropicUsage, sumMoney } from "@/utils/billable-usage";
import { priceBillingUsage } from "./billable-usage";

test("uses provider-specific rates for model-name collisions and preserves known charges when cache rates are missing", async () => {
  for (const provider of ["openrouter", "anthropic"] as const)
    await ModelModel.create({
      provider,
      modelId: "shared-model",
      externalId: `${provider}/shared-model`,
      inputModalities: ["text"],
      outputModalities: ["text"],
      customPricePerMillionInput: provider === "openrouter" ? "1" : "100",
      customPricePerMillionOutput: "5",
    });
  const priced = await priceBillingUsage({
    model: "shared-model",
    provider: "openrouter",
    mode: "enforce",
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 2000 },
  });
  expect(priced.cost).toBe("0.0002000000");
  expect(priced.status).toBe("incomplete");
  expect(priced.issues).toContain("unpriced_usage");
  const authoritative = await priceBillingUsage({
    model: "unknown",
    provider: "openrouter",
    mode: "enforce",
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 2000,
      providerReportedCost: 0.123456789,
    },
  });
  expect(authoritative.status).toBe("complete");
  expect(authoritative.cost).toBe("0.1234567890");
  expect(authoritative.components[0].prices.source).toBe("provider");
});

test("a reported total is preserved when a multi-model allocation cannot be authoritative", async () => {
  const usage = normalizeAnthropicUsage(
    {
      input_tokens: 100,
      output_tokens: 20,
      iterations: [
        { type: "message", input_tokens: 100, output_tokens: 20 },
        {
          type: "advisor_message",
          model: "advisor",
          input_tokens: 100000,
          output_tokens: 100000,
        },
      ],
    },
    "executor",
  );
  usage.providerReportedCost = 0.00001;
  const priced = await priceBillingUsage({
    model: "executor",
    provider: "anthropic",
    mode: "enforce",
    usage,
  });
  expect(priced.cost).toBe("0.0000100000");
  expect(sumMoney(priced.components.map((component) => component.cost))).toBe(
    priced.cost,
  );
  expect(priced.status).toBe("incomplete");
  expect(priced.issues).toContain("unallocated_provider_cost");
});

test("reuses the request quote across metrics and settlement when model prices change", async () => {
  const model = await ModelModel.create({
    provider: "anthropic",
    modelId: "quoted",
    externalId: "anthropic/quoted",
    inputModalities: ["text"],
    outputModalities: ["text"],
    customPricePerMillionInput: "1",
    customPricePerMillionOutput: "5",
  });
  const usage = { inputTokens: 100, outputTokens: 20 };
  const first = await priceBillingUsage({
    model: "quoted",
    provider: "anthropic",
    usage,
    mode: "enforce",
  });
  await ModelModel.update(model.id, { customPricePerMillionInput: "100" });
  const repeated = await priceBillingUsage({
    model: "quoted",
    provider: "anthropic",
    usage,
    mode: "enforce",
  });
  expect(repeated.cost).toBe(first.cost);
  const nextRequest = await priceBillingUsage({
    model: "quoted",
    provider: "anthropic",
    usage: { inputTokens: 100, outputTokens: 20 },
    mode: "enforce",
  });
  expect(nextRequest.cost).not.toBe(first.cost);
});
