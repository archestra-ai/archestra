import { describe, expect, it } from "vitest";
import { parseLabelsParam, serializeLabels } from "./label-select";

describe("parseLabelsParam", () => {
  it("returns null for null input", () => {
    expect(parseLabelsParam(null)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseLabelsParam("")).toBeNull();
  });

  it("parses a single key:value", () => {
    expect(parseLabelsParam("env:prod")).toEqual({ env: ["prod"] });
  });

  it("parses multiple values for one key", () => {
    expect(parseLabelsParam("env:prod|staging")).toEqual({
      env: ["prod", "staging"],
    });
  });

  it("parses multiple keys", () => {
    expect(parseLabelsParam("env:prod;team:backend")).toEqual({
      env: ["prod"],
      team: ["backend"],
    });
  });

  it("parses multiple keys with multiple values", () => {
    expect(parseLabelsParam("env:prod|staging;team:backend|frontend")).toEqual({
      env: ["prod", "staging"],
      team: ["backend", "frontend"],
    });
  });

  it("trims whitespace from keys and values", () => {
    expect(parseLabelsParam(" env : prod | staging ")).toEqual({
      env: ["prod", "staging"],
    });
  });

  it("ignores entries without colons", () => {
    expect(parseLabelsParam("invalidentry;env:prod")).toEqual({
      env: ["prod"],
    });
  });

  it("ignores entries with empty values", () => {
    expect(parseLabelsParam("env:")).toBeNull();
  });

  it("returns null when all entries are invalid", () => {
    expect(parseLabelsParam("novalue;alsonovalue")).toBeNull();
  });
});

describe("serializeLabels", () => {
  it("returns null for empty object", () => {
    expect(serializeLabels({})).toBeNull();
  });

  it("returns null when all keys have empty values", () => {
    expect(serializeLabels({ env: [] })).toBeNull();
  });

  it("serializes a single key:value", () => {
    expect(serializeLabels({ env: ["prod"] })).toBe("env:prod");
  });

  it("serializes multiple values for one key", () => {
    expect(serializeLabels({ env: ["prod", "staging"] })).toBe(
      "env:prod|staging",
    );
  });

  it("serializes multiple keys", () => {
    const result = serializeLabels({
      env: ["prod"],
      team: ["backend"],
    });
    expect(result).toBe("env:prod;team:backend");
  });

  it("roundtrips with parseLabelsParam", () => {
    const original = "env:prod|staging;team:backend";
    const parsed = parseLabelsParam(original);
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    const serialized = serializeLabels(parsed);
    expect(parseLabelsParam(serialized)).toEqual(parsed);
  });
});
