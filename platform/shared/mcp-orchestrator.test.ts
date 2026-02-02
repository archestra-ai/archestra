import { describe, expect, test } from "vitest";
import {
  isValidJsonKeyValueString,
  isValidK8sCpuQuantity,
  isValidK8sMemoryQuantity,
} from "./mcp-orchestrator";

describe("MCP Orchestrator Validation", () => {
  describe("isValidJsonKeyValueString", () => {
    describe("valid JSON key-value strings", () => {
      test.each([
        // Empty values (valid)
        [undefined, "undefined"],
        ["", "empty string"],
        ["  ", "whitespace only"],
        ["\n\t", "newlines and tabs"],

        // Valid JSON objects with string values
        ["{}", "empty object"],
        ['{"key": "value"}', "single key-value"],
        ['{"a": "1", "b": "2"}', "multiple key-values"],
        ['{"environment": "test", "team": "backend"}', "realistic labels"],
        ['{"prometheus.io/scrape": "true"}', "annotation-style keys"],
        ['{"a.b/c-d": "value"}', "complex key format"],

        // Whitespace in JSON
        ['{ "key" : "value" }', "spaces around tokens"],
        ['{\n  "key": "value"\n}', "multiline JSON"],
      ])("should accept %s (%s)", (value, _description) => {
        expect(isValidJsonKeyValueString(value)).toBe(true);
      });
    });

    describe("invalid JSON key-value strings", () => {
      test.each([
        // Invalid JSON syntax
        ["{key: value}", "missing quotes"],
        ['{"key": "value"', "unclosed brace"],
        ['{"key": "value",}', "trailing comma"],
        ["not json at all", "plain text"],
        ["123", "number as string"],
        ["true", "boolean as string"],
        ['"just a string"', "JSON string value"],

        // Valid JSON but wrong structure
        ["[]", "array instead of object"],
        ['["a", "b"]', "array of strings"],
        ["null", "null value"],

        // Valid JSON object but non-string values
        ['{"key": 123}', "number value"],
        ['{"key": true}', "boolean value"],
        ['{"key": null}', "null value in object"],
        ['{"key": ["a"]}', "array value"],
        ['{"key": {"nested": "obj"}}', "nested object value"],
        ['{"a": "valid", "b": 123}', "mixed string and number values"],
      ])("should reject %s (%s)", (value, _description) => {
        expect(isValidJsonKeyValueString(value)).toBe(false);
      });
    });

    describe("edge cases", () => {
      test("should handle special characters in values", () => {
        expect(isValidJsonKeyValueString('{"key": "value with spaces"}')).toBe(
          true,
        );
        expect(
          isValidJsonKeyValueString('{"key": "value\\nwith\\nnewlines"}'),
        ).toBe(true);
        expect(
          isValidJsonKeyValueString('{"key": "value\\"with\\"quotes"}'),
        ).toBe(true);
        expect(isValidJsonKeyValueString('{"key": ""}')).toBe(true); // empty string value
      });

      test("should handle unicode", () => {
        expect(isValidJsonKeyValueString('{"emoji": "🚀"}')).toBe(true);
        expect(isValidJsonKeyValueString('{"日本語": "value"}')).toBe(true);
      });
    });
  });

  describe("isValidK8sMemoryQuantity", () => {
    describe("valid memory quantities", () => {
      test.each([
        // Binary suffixes (Ki, Mi, Gi, Ti, Pi, Ei)
        ["128Mi", "MiB (mebibytes)"],
        ["1Gi", "GiB (gibibytes)"],
        ["256Ki", "KiB (kibibytes)"],
        ["1Ti", "TiB (tebibytes)"],
        ["1Pi", "PiB (pebibytes)"],
        ["1Ei", "EiB (exbibytes)"],

        // Decimal suffixes (k, K, M, G, T, P, E)
        ["128M", "MB (megabytes)"],
        ["1G", "GB (gigabytes)"],
        ["256k", "kB (kilobytes lowercase)"],
        ["256K", "KB (kilobytes uppercase)"],
        ["1T", "TB (terabytes)"],
        ["1P", "PB (petabytes)"],
        ["1E", "EB (exabytes)"],

        // Plain numbers (bytes)
        ["1024", "plain bytes"],
        ["1048576", "plain bytes (1MiB)"],
        ["0", "zero bytes"],

        // Decimal values
        ["1.5Gi", "decimal GiB"],
        ["0.5Mi", "decimal MiB"],
        ["2.5G", "decimal GB"],
        ["0.25Ti", "decimal TiB"],
      ])("should accept %s (%s)", (value) => {
        expect(isValidK8sMemoryQuantity(value)).toBe(true);
      });
    });

    describe("invalid memory quantities", () => {
      test.each([
        // Empty/whitespace
        ["", "empty string"],
        ["  ", "whitespace only"],

        // Invalid suffixes
        ["128mb", "lowercase mb"],
        ["1gb", "lowercase gb"],
        ["128MiB", "full MiB suffix"],
        ["1GiB", "full GiB suffix"],
        ["128X", "invalid suffix X"],
        ["1Zi", "invalid suffix Zi"],

        // Invalid formats
        ["abc", "letters only"],
        ["Mi128", "suffix before number"],
        ["-128Mi", "negative number"],
        ["128 Mi", "space between number and suffix"],
        ["1,024Mi", "comma in number"],
        ["1_024Mi", "underscore in number"],

        // Multiple suffixes
        ["128MiGi", "multiple suffixes"],
        ["128MM", "duplicate suffix"],
      ])("should reject %s (%s)", (value) => {
        expect(isValidK8sMemoryQuantity(value)).toBe(false);
      });
    });

    describe("edge cases", () => {
      test("should trim whitespace and validate", () => {
        expect(isValidK8sMemoryQuantity(" 128Mi ")).toBe(true);
        expect(isValidK8sMemoryQuantity("\t1Gi\n")).toBe(true);
      });

      test("should handle null-like values", () => {
        // TypeScript would normally prevent this, but testing runtime behavior
        expect(isValidK8sMemoryQuantity(null as unknown as string)).toBe(false);
        expect(isValidK8sMemoryQuantity(undefined as unknown as string)).toBe(
          false,
        );
      });
    });
  });

  describe("isValidK8sCpuQuantity", () => {
    describe("valid CPU quantities", () => {
      test.each([
        // Millicores
        ["100m", "100 millicores"],
        ["500m", "500 millicores (half core)"],
        ["1000m", "1000 millicores (1 core)"],
        ["2500m", "2500 millicores (2.5 cores)"],
        ["50m", "50 millicores"],

        // Whole cores
        ["1", "1 core"],
        ["2", "2 cores"],
        ["4", "4 cores"],
        ["16", "16 cores"],

        // Decimal cores
        ["0.5", "half core"],
        ["0.1", "0.1 core"],
        ["1.5", "1.5 cores"],
        ["2.25", "2.25 cores"],
        ["0.001", "1 millicore as decimal"],

        // Zero
        ["0", "zero CPU"],
        ["0m", "zero millicores"],
      ])("should accept %s (%s)", (value) => {
        expect(isValidK8sCpuQuantity(value)).toBe(true);
      });
    });

    describe("invalid CPU quantities", () => {
      test.each([
        // Empty/whitespace
        ["", "empty string"],
        ["  ", "whitespace only"],

        // Invalid suffixes
        ["100M", "uppercase M (memory suffix)"],
        ["1G", "G suffix (memory)"],
        ["100mi", "lowercase mi"],
        ["1c", "c suffix"],
        ["1core", "core suffix"],
        ["1cpu", "cpu suffix"],

        // Invalid formats
        ["abc", "letters only"],
        ["m100", "suffix before number"],
        ["-100m", "negative number"],
        ["100 m", "space between number and suffix"],
        ["1,000m", "comma in number"],
        ["1_000m", "underscore in number"],

        // Multiple suffixes
        ["100mm", "double m"],
        ["1.5mG", "mixed suffixes"],
      ])("should reject %s (%s)", (value) => {
        expect(isValidK8sCpuQuantity(value)).toBe(false);
      });
    });

    describe("edge cases", () => {
      test("should trim whitespace and validate", () => {
        expect(isValidK8sCpuQuantity(" 100m ")).toBe(true);
        expect(isValidK8sCpuQuantity("\t0.5\n")).toBe(true);
      });

      test("should handle null-like values", () => {
        // TypeScript would normally prevent this, but testing runtime behavior
        expect(isValidK8sCpuQuantity(null as unknown as string)).toBe(false);
        expect(isValidK8sCpuQuantity(undefined as unknown as string)).toBe(
          false,
        );
      });
    });
  });
});
