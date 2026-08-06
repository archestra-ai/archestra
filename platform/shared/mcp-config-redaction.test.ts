import { describe, expect, test } from "vitest";
import {
  REDACTED_PLACEHOLDER,
  redactCatalogToolArguments,
  redactLocalConfigSecrets,
} from "./mcp-config-redaction";

describe("redactLocalConfigSecrets", () => {
  test("removes secret-typed values and leaves plain_text alone", () => {
    const result = redactLocalConfigSecrets({
      command: "echo",
      environment: [
        { key: "TOKEN", type: "secret", value: "shh" },
        { key: "URL", type: "plain_text", value: "https://example.com" },
      ],
    });

    expect(result.environment[0].value).toBe(REDACTED_PLACEHOLDER);
    expect(result.environment[1].value).toBe("https://example.com");
    expect(result.command).toBe("echo");
  });

  test("removes image pull secret passwords", () => {
    const result = redactLocalConfigSecrets({
      imagePullSecrets: [
        {
          source: "credentials",
          server: "registry.example.com",
          username: "robot",
          password: "shh",
        },
      ],
    });

    expect(result.imagePullSecrets[0].password).toBe(REDACTED_PLACEHOLDER);
    expect(result.imagePullSecrets[0].username).toBe("robot");
  });

  test("does not mutate its input", () => {
    const input = {
      environment: [{ key: "TOKEN", type: "secret", value: "shh" }],
    };
    redactLocalConfigSecrets(input);
    expect(input.environment[0].value).toBe("shh");
  });

  test("returns the same reference when there is nothing to redact", () => {
    const input = {
      command: "echo",
      environment: [{ key: "URL", type: "plain_text", value: "x" }],
    };
    expect(redactLocalConfigSecrets(input)).toBe(input);
  });
});

describe("redactCatalogToolArguments", () => {
  test("redacts the catalog tools' secret-bearing arguments", () => {
    const result = redactCatalogToolArguments({
      id: "cat-1",
      environment: [{ key: "TOKEN", type: "secret", value: "shh" }],
      oauthConfig: { client_id: "abc", client_secret: "shh" },
    });

    expect(result.environment[0].value).toBe(REDACTED_PLACEHOLDER);
    expect(result.oauthConfig.client_secret).toBe(REDACTED_PLACEHOLDER);
    expect(result.id).toBe("cat-1");
  });

  /**
   * Matching is shape-driven, so ordinary tool arguments stay intact and the
   * tool-call log stays searchable by argument value.
   */
  test("leaves unrelated arguments alone even when their keys look sensitive", () => {
    const input = {
      query: "important document",
      password: "not-a-catalog-argument",
      value: "plain",
      environment: [{ key: "LOG_LEVEL", type: "plain_text", value: "debug" }],
    };
    expect(redactCatalogToolArguments(input)).toBe(input);
  });

  /**
   * Agents in `search_and_run_only` mode reach the catalog tools through
   * `run_tool`, which envelopes the target's arguments — so the logged call
   * carries the credential one level down.
   */
  test("redacts through a run_tool envelope", () => {
    const result = redactCatalogToolArguments({
      tool_name: "archestra__edit_mcp_config",
      tool_args: {
        id: "cat-1",
        environment: [{ key: "TOKEN", type: "secret", value: "shh" }],
      },
    });

    expect(result.tool_args.environment[0].value).toBe(REDACTED_PLACEHOLDER);
    expect(result.tool_name).toBe("archestra__edit_mcp_config");
  });

  test("passes through non-object arguments untouched", () => {
    expect(redactCatalogToolArguments(null)).toBeNull();
  });
});
