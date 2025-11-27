/**
 * Default token prices for common models.
 * Prices are in USD per million tokens.
 * Sources:
 * - Anthropic: https://platform.claude.com/docs/en/about-claude/models/overview (November 2025)
 * - OpenAI: https://openai.com/api/pricing/ (November 2025)
 */

export const defaultPrices: Record<
  string,
  { pricePerMillionInput: string; pricePerMillionOutput: string }
> = {
  // OpenAI models
  "gpt-5.1": {
    pricePerMillionInput: "1.250",
    pricePerMillionOutput: "10.000",
  },
  "gpt-5-mini": {
    pricePerMillionInput: "0.250",
    pricePerMillionOutput: "2.000",
  },
  "gpt-5-nano": {
    pricePerMillionInput: "0.050",
    pricePerMillionOutput: "0.400",
  },
  "gpt-5-pro": {
    pricePerMillionInput: "15.00",
    pricePerMillionOutput: "120.00",
  },

  // Anthropic models
  "claude-opus-4-1-20250805": {
    pricePerMillionInput: "15.00",
    pricePerMillionOutput: "75.00",
  },
  "claude-opus-4-5-20251101": {
    pricePerMillionInput: "5.00",
    pricePerMillionOutput: "25.00",
  },
  "claude-sonnet-4-5-20250929": {
    pricePerMillionInput: "3.00",
    pricePerMillionOutput: "15.00",
  },
  "claude-haiku-4-5-20251001": {
    pricePerMillionInput: "1.00",
    pricePerMillionOutput: "5.00",
  },
};

/**
 * Get default pricing for a model
 * Falls back to $50/$50 per million tokens if model not found
 */
export function getDefaultPricing(model: string): {
  pricePerMillionInput: string;
  pricePerMillionOutput: string;
} {
  return (
    defaultPrices[model] ?? {
      pricePerMillionInput: "50.00",
      pricePerMillionOutput: "50.00",
    }
  );
}
