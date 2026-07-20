/**
 * Narrow a nullable lookup result in a test: rows the test itself just
 * created are expected to exist, so a miss is a setup failure worth throwing
 * on — never a case for a non-null assertion.
 */
export function mustExist<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Expected the looked-up row to exist");
  return value;
}
