/** Validate an exact decimal price against the custom model price range. */
export function isValidModelPrice(value: string): boolean {
  return normalizeModelPrice(value) !== null;
}

/**
 * Return the price as numeric(16,8) stores it, or null for invalid input.
 * Validate before rounding and round half-up on decimal digits so prices near
 * the maximum and halfway values do not lose precision through Number.
 */
export function normalizeModelPrice(value: string): string | null {
  const match = DECIMAL_PRICE_PATTERN.exec(value.trim());
  if (!match) return null;
  const [, sign, whole = "", fraction = "", fractionOnly = "", exponent = "0"] =
    match;
  const rawDigits = whole + (fraction || fractionOnly);
  const digits = rawDigits.replace(/^0+/, "");
  if (!digits) return "0.00000000";
  if (sign === "-") return null;

  // Locate the decimal point relative to the first nonzero digit. Keep even
  // extreme exponents bounded without allocating their implied zero padding.
  const decimalPosition =
    BigInt(whole.length - (rawDigits.length - digits.length)) +
    BigInt(exponent);
  if (decimalPosition > BigInt(8)) return null;
  if (
    decimalPosition === BigInt(8) &&
    digits.padEnd(10, "0").slice(0, 10) === "9999999999" &&
    /[1-9]/.test(digits.slice(10))
  ) {
    return null;
  }

  const scaledPosition = decimalPosition + BigInt(8);
  if (scaledPosition < BigInt(0)) return "0.00000000";
  // Bounded to 0..16 by the range check above; only this index becomes Number.
  const length = Number(scaledPosition);
  const roundUp = (digits[length] ?? "0") >= "5" ? BigInt(1) : BigInt(0);
  const scaled =
    BigInt(digits.slice(0, length).padEnd(length, "0") || "0") + roundUp;
  const stored = scaled.toString().padStart(9, "0");
  return `${stored.slice(0, -8)}.${stored.slice(-8)}`;
}

const DECIMAL_PRICE_PATTERN =
  /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/;
