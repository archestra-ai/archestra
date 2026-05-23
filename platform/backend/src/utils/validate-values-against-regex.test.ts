import { describe, expect, test } from "vitest";
import { validateValuesAgainstRegex } from "./validate-values-against-regex";

describe("validateValuesAgainstRegex", () => {
  test("no-op when regex is null", () => {
    expect(() =>
      validateValuesAgainstRegex({ a: "anything" }, null, "prod"),
    ).not.toThrow();
  });

  test("no-op when regex is empty string", () => {
    expect(() =>
      validateValuesAgainstRegex({ a: "anything" }, "", "prod"),
    ).not.toThrow();
  });

  test("no-op when values is null/undefined", () => {
    expect(() => validateValuesAgainstRegex(null, "^x$", "prod")).not.toThrow();
    expect(() =>
      validateValuesAgainstRegex(undefined, "^x$", "prod"),
    ).not.toThrow();
  });

  test("skips null, undefined, and empty string values", () => {
    expect(() =>
      validateValuesAgainstRegex(
        { a: null, b: undefined, c: "" },
        "^https://",
        "prod",
      ),
    ).not.toThrow();
  });

  test("passes when every value matches", () => {
    expect(() =>
      validateValuesAgainstRegex(
        { url: "https://a.example.com", api: "https://b.example.com/v1" },
        "^https://",
        "prod",
      ),
    ).not.toThrow();
  });

  test("throws with the key name and the target name", () => {
    expect(() =>
      validateValuesAgainstRegex(
        { url: "https://a.example.com", api: "http://insecure" },
        "^https://",
        "production",
      ),
    ).toThrow(/"api".*"production"/);
  });

  test("supports negative lookahead", () => {
    expect(() =>
      validateValuesAgainstRegex(
        { region: "eu-west-1" },
        "^(?!.*prod).*$",
        "prod",
      ),
    ).not.toThrow();
    expect(() =>
      validateValuesAgainstRegex(
        { region: "us-prod-1" },
        "^(?!.*prod).*$",
        "prod",
      ),
    ).toThrow();
  });

  test("coerces non-string scalars before testing", () => {
    expect(() =>
      validateValuesAgainstRegex({ count: 42 }, "^[0-9]+$", "prod"),
    ).not.toThrow();
    expect(() =>
      validateValuesAgainstRegex({ count: 42 }, "^[a-z]+$", "prod"),
    ).toThrow();
  });

  test("error message does NOT include the regex itself", () => {
    expect(() =>
      validateValuesAgainstRegex({ api: "no" }, "^secret-pattern$", "prod"),
    ).toThrow(/^((?!secret-pattern).)*$/);
  });
});
