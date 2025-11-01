import { stripEnvVarQuotes } from "./utils";

describe("stripEnvVarQuotes", () => {
  describe("double quotes", () => {
    it("should strip double quotes from a simple value", () => {
      expect(stripEnvVarQuotes('"value"')).toBe("value");
    });

    it("should strip double quotes from URL with port", () => {
      expect(stripEnvVarQuotes('"http://grafana:80"')).toBe(
        "http://grafana:80",
      );
    });

    it("should strip double quotes from URL with protocol", () => {
      expect(stripEnvVarQuotes('"https://example.com"')).toBe(
        "https://example.com",
      );
    });

    it("should strip double quotes from path with special characters", () => {
      expect(stripEnvVarQuotes('"/path/to/file"')).toBe("/path/to/file");
    });

    it("should strip double quotes from value with spaces", () => {
      expect(stripEnvVarQuotes('"hello world"')).toBe("hello world");
    });

    it("should strip double quotes from empty string", () => {
      expect(stripEnvVarQuotes('""')).toBe("");
    });

    it("should preserve internal double quotes", () => {
      expect(stripEnvVarQuotes('"say "hello" there"')).toBe(
        'say "hello" there',
      );
    });
  });

  describe("single quotes", () => {
    it("should strip single quotes from a simple value", () => {
      expect(stripEnvVarQuotes("'value'")).toBe("value");
    });

    it("should strip single quotes from URL with port", () => {
      expect(stripEnvVarQuotes("'http://grafana:80'")).toBe(
        "http://grafana:80",
      );
    });

    it("should strip single quotes from empty string", () => {
      expect(stripEnvVarQuotes("''")).toBe("");
    });

    it("should preserve internal single quotes", () => {
      expect(stripEnvVarQuotes("'it's working'")).toBe("it's working");
    });
  });

  describe("no quotes", () => {
    it("should return value as-is when no quotes present", () => {
      expect(stripEnvVarQuotes("no-quotes")).toBe("no-quotes");
    });

    it("should return URL without quotes as-is", () => {
      expect(stripEnvVarQuotes("http://grafana:80")).toBe("http://grafana:80");
    });

    it("should return number string as-is", () => {
      expect(stripEnvVarQuotes("3000")).toBe("3000");
    });

    it("should return path without quotes as-is", () => {
      expect(stripEnvVarQuotes("/path/to/file")).toBe("/path/to/file");
    });

    it("should return value with spaces as-is when no quotes", () => {
      expect(stripEnvVarQuotes("hello world")).toBe("hello world");
    });
  });

  describe("mismatched quotes", () => {
    it("should not strip when starting with double and ending with single", () => {
      expect(stripEnvVarQuotes('"value\'")).toBe('"value\'');
    });

    it("should not strip when starting with single and ending with double", () => {
      expect(stripEnvVarQuotes('\'value"')).toBe('\'value"');
    });

    it("should not strip when only starting quote present", () => {
      expect(stripEnvVarQuotes('"value')).toBe('"value');
    });

    it("should not strip when only ending quote present", () => {
      expect(stripEnvVarQuotes('value"')).toBe('value"');
    });
  });

  describe("edge cases", () => {
    it("should handle empty string", () => {
      expect(stripEnvVarQuotes("")).toBe("");
    });

    it("should handle single character", () => {
      expect(stripEnvVarQuotes("a")).toBe("a");
    });

    it("should handle single quote character", () => {
      expect(stripEnvVarQuotes('"')).toBe('"');
    });

    it("should handle value with equals signs", () => {
      expect(stripEnvVarQuotes('"key=value=more"')).toBe("key=value=more");
    });

    it("should handle value with newlines", () => {
      expect(stripEnvVarQuotes('"line1\\nline2"')).toBe("line1\\nline2");
    });

    it("should handle value with JSON-like content", () => {
      expect(stripEnvVarQuotes('\'{"key": "value"}\'')).toBe(
        '{"key": "value"}',
      );
    });

    it("should handle multiple nested quotes of same type", () => {
      expect(stripEnvVarQuotes('"""value"""')).toBe('""value""');
    });

    it("should handle API keys with special characters", () => {
      expect(stripEnvVarQuotes('"sk-1234_abcd-EFGH"')).toBe(
        "sk-1234_abcd-EFGH",
      );
    });
  });

  describe("real-world environment variable examples", () => {
    it("should handle DATABASE_URL with quotes", () => {
      expect(
        stripEnvVarQuotes('"postgresql://user:pass@localhost:5432/db"'),
      ).toBe("postgresql://user:pass@localhost:5432/db");
    });

    it("should handle API_KEY with quotes", () => {
      expect(stripEnvVarQuotes('"sk-proj-abc123"')).toBe("sk-proj-abc123");
    });

    it("should handle PORT with quotes", () => {
      expect(stripEnvVarQuotes('"3000"')).toBe("3000");
    });

    it("should handle REDIS_URL with quotes", () => {
      expect(stripEnvVarQuotes('"redis://localhost:6379"')).toBe(
        "redis://localhost:6379",
      );
    });

    it("should handle NODE_ENV with quotes", () => {
      expect(stripEnvVarQuotes('"production"')).toBe("production");
    });

    it("should handle FEATURE_FLAGS with JSON", () => {
      expect(stripEnvVarQuotes('\'{"feature1":true,"feature2":false}\'')).toBe(
        '{"feature1":true,"feature2":false}',
      );
    });
  });
});
