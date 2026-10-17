/** Validate the full decimal string before it reaches a numeric(10, 2) column. */
export function isValidModelPrice(value: string): boolean {
  const trimmed = value.trim();
  if (!DECIMAL_PRICE_PATTERN.test(trimmed)) return false;
  const price = Number(trimmed);
  return Number.isFinite(price) && price >= 0 && price <= 99_999_999.99;
}

const DECIMAL_PRICE_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
