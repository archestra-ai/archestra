import { describe, expect, test } from "vitest";
import { ensureStringIsRfc1123Compliant } from "./deployment-names";

describe("ensureStringIsRfc1123Compliant", () => {
  test.each([
    ["My Server", "my-server"],
    ["TEST-VALUE", "test-value"],
    ["hello_world", "helloworld"],
    ["a..b", "a.b"],
    ["a--b", "a-b"],
    ["-leading", "leading"],
    ["trailing-", "trailing"],
    ["UPPER CASE", "upper-case"],
  ])("converts '%s' to '%s'", (input, expected) => {
    expect(ensureStringIsRfc1123Compliant(input)).toBe(expected);
  });
});
