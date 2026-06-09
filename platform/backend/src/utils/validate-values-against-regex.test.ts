import { describe, expect, it } from "vitest";
import { validateValuesAgainstRegex } from "./validate-values-against-regex";

describe("validateValuesAgainstRegex", () => {
  const allowlist = "^(?!.*(prod|production)).*$";

  it("is a no-op when the regex is null/empty (validation disabled)", () => {
    expect(() =>
      validateValuesAgainstRegex({ url: "anything-prod" }, null, "staging"),
    ).not.toThrow();
    expect(() =>
      validateValuesAgainstRegex({ url: "anything-prod" }, "", "staging"),
    ).not.toThrow();
  });

  it("is a no-op when values is null/empty", () => {
    expect(() =>
      validateValuesAgainstRegex(null, allowlist, "staging"),
    ).not.toThrow();
    expect(() =>
      validateValuesAgainstRegex({}, allowlist, "staging"),
    ).not.toThrow();
  });

  it("passes when every value matches the allowlist", () => {
    expect(() =>
      validateValuesAgainstRegex(
        { host: "staging-host", region: "eu" },
        allowlist,
        "staging",
      ),
    ).not.toThrow();
  });

  it("throws on the first value that fails the allowlist", () => {
    expect(() =>
      validateValuesAgainstRegex(
        { host: "my-prod-host" },
        allowlist,
        "staging",
      ),
    ).toThrow(/does not match the validation pattern required by "staging"/);
  });

  it("names the offending key but never echoes the regex", () => {
    let message = "";
    try {
      validateValuesAgainstRegex({ DB_URL: "production-db" }, allowlist, "qa");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('"DB_URL"');
    expect(message).toContain('"qa"');
    expect(message).not.toContain(allowlist);
  });

  it("skips null and empty-string values", () => {
    expect(() =>
      validateValuesAgainstRegex(
        { a: null, b: "", c: undefined, d: "staging" },
        allowlist,
        "staging",
      ),
    ).not.toThrow();
  });

  it("coerces non-string values to string before testing", () => {
    // A digits-only allowlist: a numeric value coerces and matches.
    expect(() =>
      validateValuesAgainstRegex({ port: 8080 }, "^[0-9]+$", "staging"),
    ).not.toThrow();
    expect(() =>
      validateValuesAgainstRegex({ flag: "abc" }, "^[0-9]+$", "staging"),
    ).toThrow();
  });
});
