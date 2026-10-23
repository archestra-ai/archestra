import type { AzureModelEvidence } from "@archestra/shared/azure-models";
import { z } from "zod";
import type { Model } from "./model";

/** USD per token, as published by this provider instance. Null means unknown. */
export const ProviderModelPricingSchema = z.object({
  promptPricePerToken: z.string().nullable(),
  completionPricePerToken: z.string().nullable(),
  cacheReadPricePerToken: z.string().nullable(),
  cacheWritePricePerToken: z.string().nullable(),
});
export type ProviderModelPricing = z.infer<typeof ProviderModelPricingSchema>;

/** A model projected through one instance, or a merged view with no single rate. */
export type ProviderPricedModel = Model & {
  providerPricing?: ProviderModelPricing | "conflicting";
  azureCapabilities?: AzureModelEvidence | null;
};
