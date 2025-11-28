/**
 * Returns default token prices for a model.
 * Cheaper models (-haiku, -nano, -mini) get $30/million tokens.
 * All other models get $50/million tokens.
 *
 * Why this approach?
 * 1. We autodetect the model from the interaction. Setting the default to $50 helps signal
 *    that the value should be updated later with the correct pricing.
 * 2. Companies may have custom pricing. If we used the “official” model prices here,
 *    it would be harder to notice when the pricing is incorrect.
 * 3. Smaller models may be used in Optimization Rules. Even if pricing isn’t configured,
 *    we still want to surface potential cost savings.
 */
function getDefaultModelPrice(model: string): {
  pricePerMillionInput: string;
  pricePerMillionOutput: string;
} {
  const cheaperPatterns = ["-haiku", "-nano", "-mini"];
  const isCheaper = cheaperPatterns.some((pattern) =>
    model.toLowerCase().includes(pattern),
  );

  const price = isCheaper ? "30.00" : "50.00";
  return {
    pricePerMillionInput: price,
    pricePerMillionOutput: price,
  };
}

export default getDefaultModelPrice;
