import { formSchema } from "./mcp-catalog-form.types";
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

  describe("edge cases", () => {
    it("should return empty string for empty input", () => {
      expect(stripEnvVarQuotes("")).toBe("");
    });

    it("should return single character as-is", () => {
      expect(stripEnvVarQuotes("a")).toBe("a");
      expect(stripEnvVarQuotes('"')).toBe('"');
    });

    it("should not strip mismatched quotes", () => {
      expect(stripEnvVarQuotes("\"value'")).toBe("\"value'");
      expect(stripEnvVarQuotes("'value\"")).toBe("'value\"");
    });

    it("should not strip quotes that are not at both ends", () => {
      expect(stripEnvVarQuotes('value"')).toBe('value"');
      expect(stripEnvVarQuotes('"value')).toBe('"value');
    });

    it("should handle values with internal quotes", () => {
      expect(stripEnvVarQuotes('"value with "quotes" inside"')).toBe(
        'value with "quotes" inside',
      );
    });

    it("should handle escaped quotes inside", () => {
      expect(stripEnvVarQuotes('"value\\"escaped\\""')).toBe(
        'value\\"escaped\\"',
      );
    });
  });
});

describe("formSchema", () => {
  const baseValidData = {
    name: "Test MCP Server",
    authMethod: "none" as const,
    oauthConfig: undefined,
  };

  describe("remote servers", () => {
    it("should validate remote server with valid URL", () => {
      const data = {
        ...baseValidData,
        serverType: "remote" as const,
        serverUrl: "https://api.example.com/mcp",
        localConfig: undefined,
      };

      expect(formSchema.parse(data)).toEqual(data);
    });

    it("should reject remote server without URL", () => {
      const data = {
        ...baseValidData,
        serverType: "remote" as const,
        serverUrl: "",
        localConfig: undefined,
      };

      expect(() => formSchema.parse(data)).toThrow(
        "Server URL is required for remote servers",
      );
    });

    it("should reject remote server with invalid URL", () => {
      const data = {
        ...baseValidData,
        serverType: "remote" as const,
        serverUrl: "not-a-url",
        localConfig: undefined,
      };

      expect(() => formSchema.parse(data)).toThrow("Must be a valid URL");
    });
  });

  describe("local servers", () => {
    it("should validate local server with command only", () => {
      const data = {
        ...baseValidData,
        serverType: "local" as const,
        serverUrl: "",
        localConfig: {
          command: "node",
          arguments: "",
          environment: [],
          dockerImage: "",
          transportType: "stdio" as const,
          httpPort: "",
          httpPath: "/mcp",
        },
      };

      expect(formSchema.parse(data)).toEqual(data);
    });

    it("should validate local server with Docker image only", () => {
      const data = {
        ...baseValidData,
        serverType: "local" as const,
        serverUrl: "",
        localConfig: {
          command: "",
          arguments: "",
          environment: [],
          dockerImage: "registry.example.com/my-mcp-server:latest",
          transportType: "stdio" as const,
          httpPort: "",
          httpPath: "/mcp",
        },
      };

      expect(formSchema.parse(data)).toEqual(data);
    });

    it("should validate local server with both command and Docker image", () => {
      const data = {
        ...baseValidData,
        serverType: "local" as const,
        serverUrl: "",
        localConfig: {
          command: "node",
          arguments: "/app/server.js",
          environment: [
            {
              key: "NODE_ENV",
              type: "plain_text" as const,
              value: "production",
              promptOnInstallation: false,
            },
          ],
          dockerImage: "registry.example.com/my-mcp-server:latest",
          transportType: "streamable-http" as const,
          httpPort: "8080",
          httpPath: "/mcp",
        },
      };

      expect(formSchema.parse(data)).toEqual(data);
    });

    it("should reject local server without command or Docker image", () => {
      const data = {
        ...baseValidData,
        serverType: "local" as const,
        serverUrl: "",
        localConfig: {
          command: "",
          arguments: "",
          environment: [],
          dockerImage: "",
          transportType: "stdio" as const,
          httpPort: "",
          httpPath: "/mcp",
        },
      };

      expect(() => formSchema.parse(data)).toThrow(
        "Either command or Docker image must be provided",
      );
    });

    it("should reject local server with only whitespace command", () => {
      const data = {
        ...baseValidData,
        serverType: "local" as const,
        serverUrl: "",
        localConfig: {
          command: "   ",
          arguments: "",
          environment: [],
          dockerImage: "",
          transportType: "stdio" as const,
          httpPort: "",
          httpPath: "/mcp",
        },
      };

      expect(() => formSchema.parse(data)).toThrow(
        "Either command or Docker image must be provided",
      );
    });

    it("should validate streamable-http transport type", () => {
      const data = {
        ...baseValidData,
        serverType: "local" as const,
        serverUrl: "",
        localConfig: {
          command: "node",
          arguments: "",
          environment: [],
          dockerImage: "",
          transportType: "streamable-http" as const,
          httpPort: "3000",
          httpPath: "/api/mcp",
        },
      };

      expect(formSchema.parse(data)).toEqual(data);
    });
  });

  describe("required fields", () => {
    it("should reject empty name", () => {
      const data = {
        ...baseValidData,
        name: "",
        serverType: "remote" as const,
        serverUrl: "https://api.example.com/mcp",
        localConfig: undefined,
      };

      expect(() => formSchema.parse(data)).toThrow("Name is required");
    });

    it("should validate OAuth configuration when authMethod is oauth", () => {
      const data = {
        ...baseValidData,
        authMethod: "oauth" as const,
        serverType: "remote" as const,
        serverUrl: "https://api.example.com/mcp",
        oauthConfig: {
          client_id: "test-client-id",
          client_secret: "test-secret",
          redirect_uris: "https://localhost:3000/oauth-callback",
          scopes: "read,write",
          supports_resource_metadata: true,
        },
        localConfig: undefined,
      };

      expect(formSchema.parse(data)).toEqual(data);
    });

    it("should reject OAuth config with empty redirect_uris", () => {
      const data = {
        ...baseValidData,
        authMethod: "oauth" as const,
        serverType: "remote" as const,
        serverUrl: "https://api.example.com/mcp",
        oauthConfig: {
          client_id: "test-client-id",
          client_secret: "test-secret",
          redirect_uris: "",
          scopes: "read,write",
          supports_resource_metadata: true,
        },
        localConfig: undefined,
      };

      expect(() => formSchema.parse(data)).toThrow(
        "At least one redirect URI is required",
      );
    });
  });
});
