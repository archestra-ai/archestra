import { stripEnvVarQuotes } from "./mcp-catalog-form.utils";

describe("stripEnvVarQuotes", () => {
  describe("real-world environment variable examples", () => {
    it.each([
      [
        "should handle DATABASE_URL with quotes",
        '"postgresql://user:pass@localhost:5432/db"',
        "postgresql://user:pass@localhost:5432/db",
      ],
      [
        "should handle API_KEY with quotes",
        '"sk-proj-abc123"',
        "sk-proj-abc123",
      ],
      ["should handle PORT with quotes", '"3000"', "3000"],
      [
        "should handle REDIS_URL with quotes",
        '"redis://localhost:6379"',
        "redis://localhost:6379",
      ],
      ["should handle NODE_ENV with quotes", '"production"', "production"],
      [
        "should handle FEATURE_FLAGS with JSON",
        '\'{"feature1":true,"feature2":false}\'',
        '{"feature1":true,"feature2":false}',
      ],
    ])("%s", (_, input, expected) => {
      expect(stripEnvVarQuotes(input)).toBe(expected);
    });
  });
});
