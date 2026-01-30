import { formSchema } from "./mcp-catalog-form.types";
import {
  buildResources,
  parseJsonSafe,
  stripEnvVarQuotes,
} from "./mcp-catalog-form.utils";

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

describe("parseJsonSafe", () => {
  describe("valid JSON objects", () => {
    it("should parse empty object", () => {
      expect(parseJsonSafe("{}")).toEqual({});
    });

    it("should parse object with string values", () => {
      expect(parseJsonSafe('{"key": "value"}')).toEqual({ key: "value" });
    });

    it("should parse object with multiple key-values", () => {
      expect(parseJsonSafe('{"a": "1", "b": "2"}')).toEqual({ a: "1", b: "2" });
    });

    it("should parse K8s-style labels", () => {
      expect(
        parseJsonSafe('{"app.kubernetes.io/name": "test", "env": "prod"}'),
      ).toEqual({
        "app.kubernetes.io/name": "test",
        env: "prod",
      });
    });

    it("should handle whitespace in JSON", () => {
      expect(parseJsonSafe('{ "key" : "value" }')).toEqual({ key: "value" });
    });

    it("should handle multiline JSON", () => {
      expect(parseJsonSafe('{\n  "key": "value"\n}')).toEqual({ key: "value" });
    });
  });

  describe("invalid or empty inputs", () => {
    it("should return undefined for empty string", () => {
      expect(parseJsonSafe("")).toBeUndefined();
    });

    it("should return undefined for whitespace only", () => {
      expect(parseJsonSafe("   ")).toBeUndefined();
      expect(parseJsonSafe("\n\t")).toBeUndefined();
    });

    it("should return undefined for invalid JSON syntax", () => {
      expect(parseJsonSafe("{key: value}")).toBeUndefined();
      expect(parseJsonSafe('{"key": "value"')).toBeUndefined();
      expect(parseJsonSafe("not json")).toBeUndefined();
    });

    it("should return undefined for arrays", () => {
      expect(parseJsonSafe("[]")).toBeUndefined();
      expect(parseJsonSafe('["a", "b"]')).toBeUndefined();
    });

    it("should return undefined for null", () => {
      expect(parseJsonSafe("null")).toBeUndefined();
    });

    it("should return undefined for primitives", () => {
      expect(parseJsonSafe("123")).toBeUndefined();
      expect(parseJsonSafe("true")).toBeUndefined();
      expect(parseJsonSafe('"just a string"')).toBeUndefined();
    });
  });

  describe("objects with non-string values", () => {
    it("should still parse objects with non-string values (no type enforcement)", () => {
      // Note: parseJsonSafe doesn't enforce string values, it just casts
      expect(parseJsonSafe('{"key": 123}')).toEqual({ key: 123 });
      expect(parseJsonSafe('{"key": true}')).toEqual({ key: true });
    });
  });
});

describe("buildResources", () => {
  describe("returns undefined when no resources specified", () => {
    it("should return undefined for empty config", () => {
      expect(buildResources({})).toBeUndefined();
    });

    it("should return undefined when all fields are undefined", () => {
      expect(
        buildResources({
          resourceRequestsMemory: undefined,
          resourceRequestsCpu: undefined,
          resourceLimitsMemory: undefined,
          resourceLimitsCpu: undefined,
        }),
      ).toBeUndefined();
    });

    it("should return undefined when all fields are empty strings", () => {
      expect(
        buildResources({
          resourceRequestsMemory: "",
          resourceRequestsCpu: "",
          resourceLimitsMemory: "",
          resourceLimitsCpu: "",
        }),
      ).toBeUndefined();
    });
  });

  describe("requests only", () => {
    it("should build with memory request only", () => {
      expect(
        buildResources({
          resourceRequestsMemory: "128Mi",
        }),
      ).toEqual({
        requests: { memory: "128Mi" },
      });
    });

    it("should build with CPU request only", () => {
      expect(
        buildResources({
          resourceRequestsCpu: "100m",
        }),
      ).toEqual({
        requests: { cpu: "100m" },
      });
    });

    it("should build with both memory and CPU requests", () => {
      expect(
        buildResources({
          resourceRequestsMemory: "256Mi",
          resourceRequestsCpu: "200m",
        }),
      ).toEqual({
        requests: { memory: "256Mi", cpu: "200m" },
      });
    });
  });

  describe("limits only", () => {
    it("should build with memory limit only", () => {
      expect(
        buildResources({
          resourceLimitsMemory: "512Mi",
        }),
      ).toEqual({
        limits: { memory: "512Mi" },
      });
    });

    it("should build with CPU limit only", () => {
      expect(
        buildResources({
          resourceLimitsCpu: "500m",
        }),
      ).toEqual({
        limits: { cpu: "500m" },
      });
    });

    it("should build with both memory and CPU limits", () => {
      expect(
        buildResources({
          resourceLimitsMemory: "1Gi",
          resourceLimitsCpu: "1",
        }),
      ).toEqual({
        limits: { memory: "1Gi", cpu: "1" },
      });
    });
  });

  describe("both requests and limits", () => {
    it("should build with all fields specified", () => {
      expect(
        buildResources({
          resourceRequestsMemory: "128Mi",
          resourceRequestsCpu: "100m",
          resourceLimitsMemory: "512Mi",
          resourceLimitsCpu: "500m",
        }),
      ).toEqual({
        requests: { memory: "128Mi", cpu: "100m" },
        limits: { memory: "512Mi", cpu: "500m" },
      });
    });

    it("should build with partial requests and limits", () => {
      expect(
        buildResources({
          resourceRequestsMemory: "256Mi",
          resourceLimitsCpu: "1",
        }),
      ).toEqual({
        requests: { memory: "256Mi" },
        limits: { cpu: "1" },
      });
    });

    it("should handle mixed empty and set values", () => {
      expect(
        buildResources({
          resourceRequestsMemory: "",
          resourceRequestsCpu: "100m",
          resourceLimitsMemory: "512Mi",
          resourceLimitsCpu: "",
        }),
      ).toEqual({
        requests: { cpu: "100m" },
        limits: { memory: "512Mi" },
      });
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
