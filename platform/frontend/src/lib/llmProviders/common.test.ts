import { describe, expect, it } from "vitest";
import { parseAuthRequired, parsePolicyDenied } from "./common";

describe("parsePolicyDenied", () => {
  it("parses a plain-text policy denial with tool name, args, and reason", () => {
    const text =
      '\nI tried to invoke the upstash__context7__get-library-docs tool with the following arguments: {"context7CompatibleLibraryID":"/websites/p5js_reference"}.\n\nHowever, I was denied by a tool invocation policy:\n\nTool invocation blocked: context contains untrusted data';
    const result = parsePolicyDenied(text);
    expect(result).not.toBeNull();
    expect(result?.type).toBe("tool-upstash__context7__get-library-docs");
    expect(result?.state).toBe("output-denied");
    expect(result?.input).toEqual({
      context7CompatibleLibraryID: "/websites/p5js_reference",
    });
    const errorInfo = JSON.parse(result?.errorText ?? "");
    expect(errorInfo.reason).toContain("context contains untrusted data");
  });

  it("parses a JSON-wrapped policy denial (originalError.message)", () => {
    const inner =
      '\nI tried to invoke the my-tool tool with the following arguments: {"key":"value"}.\n\nHowever, I was denied by a tool invocation policy:\n\nBlocked by admin';
    const text = JSON.stringify({
      code: "unknown",
      originalError: { message: inner },
    });
    const result = parsePolicyDenied(text);
    expect(result).not.toBeNull();
    expect(result?.type).toBe("tool-my-tool");
    expect(result?.input).toEqual({ key: "value" });
  });

  it("parses a JSON-wrapped policy denial (message)", () => {
    const inner =
      "\nI tried to invoke the some-tool tool with the following arguments: {}.\n\nHowever, I was denied by a tool invocation policy:\n\nNot allowed";
    const text = JSON.stringify({ message: inner });
    const result = parsePolicyDenied(text);
    expect(result).not.toBeNull();
    expect(result?.type).toBe("tool-some-tool");
  });

  it("returns null for unrelated text", () => {
    expect(parsePolicyDenied("Hello world")).toBeNull();
  });

  it("returns null for text missing required keywords", () => {
    expect(
      parsePolicyDenied("The tool was denied access to the resource"),
    ).toBeNull();
  });

  it("returns null for text with keywords but no matching pattern", () => {
    const text =
      "The tool invocation was denied by policy but has no structured format";
    expect(parsePolicyDenied(text)).toBeNull();
  });
});

describe("parseAuthRequired", () => {
  const makeDirectErrorText = (catalogName: string, installUrl: string) =>
    `Authentication required for "${catalogName}".\n\nNo credentials were found for your account (user: usr_123).\nTo set up your credentials, visit: ${installUrl}\n\nOnce you have completed authentication, retry this tool call.`;

  it("parses a direct text auth-required error", () => {
    const url = "http://localhost:3000/mcp-catalog/registry?install=cat_abc";
    const text = makeDirectErrorText("jira-atlassian-remote", url);
    const result = parseAuthRequired(text);
    expect(result).toEqual({
      catalogName: "jira-atlassian-remote",
      installUrl: url,
    });
  });

  it("parses a JSON-wrapped auth-required error (originalError.message)", () => {
    const url = "https://app.example.com/mcp-catalog/registry?install=cat_xyz";
    const inner = makeDirectErrorText("slack-remote", url);
    const text = JSON.stringify({
      code: "unknown",
      originalError: { message: inner },
    });
    const result = parseAuthRequired(text);
    expect(result).toEqual({
      catalogName: "slack-remote",
      installUrl: url,
    });
  });

  it("parses a JSON-wrapped auth-required error (message)", () => {
    const url = "http://localhost:3000/mcp-catalog/registry?install=cat_123";
    const inner = makeDirectErrorText("github-remote", url);
    const text = JSON.stringify({ message: inner });
    const result = parseAuthRequired(text);
    expect(result).toEqual({
      catalogName: "github-remote",
      installUrl: url,
    });
  });

  it("handles catalog names with special characters", () => {
    const url = "http://localhost:3000/mcp-catalog/registry?install=cat_456";
    const text = makeDirectErrorText("my-org/custom-server", url);
    const result = parseAuthRequired(text);
    expect(result).toEqual({
      catalogName: "my-org/custom-server",
      installUrl: url,
    });
  });

  it("returns null for unrelated text", () => {
    expect(parseAuthRequired("Hello world")).toBeNull();
  });

  it("returns null for text with 'Authentication' but not the full pattern", () => {
    expect(
      parseAuthRequired("Authentication failed for some reason"),
    ).toBeNull();
  });

  it("returns null when Authentication required is present but URL is missing", () => {
    const text =
      'Authentication required for "some-tool".\n\nPlease authenticate.';
    expect(parseAuthRequired(text)).toBeNull();
  });

  it("returns null for policy denial errors", () => {
    const text =
      "\nI tried to invoke the my-tool tool with the following arguments: {}.\n\nHowever, I was denied by a tool invocation policy:\n\nBlocked";
    expect(parseAuthRequired(text)).toBeNull();
  });
});
