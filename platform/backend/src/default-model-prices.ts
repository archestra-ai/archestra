/**
 * Returns default token prices for a model.
 * Cheaper models (-haiku, -nano, -mini) get $30/million tokens.
 * All other models get $50/million tokens.
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
