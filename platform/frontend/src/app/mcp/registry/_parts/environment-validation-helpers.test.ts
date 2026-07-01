import { describe, expect, it } from "vitest";
import {
  compileValidationRegex,
  toFieldValueType,
  validateFieldAgainstRegex,
} from "./environment-validation-helpers";

describe("toFieldValueType", () => {
  it("maps numeric and boolean field types, treating everything else as free-text string", () => {
    expect(toFieldValueType("number")).toBe("number");
    expect(toFieldValueType("boolean")).toBe("boolean");
    expect(toFieldValueType("string")).toBe("string");
    expect(toFieldValueType("plain_text")).toBe("string");
    expect(toFieldValueType("directory")).toBe("string");
    expect(toFieldValueType("file")).toBe("string");
    expect(toFieldValueType(undefined)).toBe("string");
  });
});

describe("compileValidationRegex", () => {
  it("returns null for empty/null sources (validation disabled)", () => {
    expect(compileValidationRegex(null)).toBeNull();
    expect(compileValidationRegex(undefined)).toBeNull();
    expect(compileValidationRegex("")).toBeNull();
  });

  it("returns null for an uncompilable source", () => {
    expect(compileValidationRegex("([unclosed")).toBeNull();
  });

  it("compiles a valid source", () => {
    const re = compileValidationRegex("^(?!.*prod).*$");
    expect(re).toBeInstanceOf(RegExp);
    expect(re?.test("staging-host")).toBe(true);
    expect(re?.test("prod-host")).toBe(false);
  });
});

describe("validateFieldAgainstRegex", () => {
  const regex = compileValidationRegex("^(?!.*prod).*$");

  it("passes when there is no rule", () => {
    expect(
      validateFieldAgainstRegex({
        value: "prod",
        regex: null,
        valueType: "string",
        environmentName: "staging",
      }),
    ).toBeNull();
  });

  it("returns an error naming the environment when a string value violates the rule", () => {
    expect(
      validateFieldAgainstRegex({
        value: "my-prod-host",
        regex,
        valueType: "string",
        environmentName: "staging",
      }),
    ).toBe("Value does not match the staging validation rule");
  });

  it("passes a matching string value", () => {
    expect(
      validateFieldAgainstRegex({
        value: "staging-host",
        regex,
        valueType: "string",
        environmentName: "staging",
      }),
    ).toBeNull();
  });

  it("bypasses non-string fields and empty values", () => {
    expect(
      validateFieldAgainstRegex({
        value: "prod",
        regex,
        valueType: "number",
        environmentName: "staging",
      }),
    ).toBeNull();
    expect(
      validateFieldAgainstRegex({
        value: "",
        regex,
        valueType: "string",
        environmentName: "staging",
      }),
    ).toBeNull();
  });
});
