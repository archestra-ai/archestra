import {
  EXECUTION_ID_HEADER,
  EXTERNAL_AGENT_ID_HEADER,
  META_HEADER,
} from "@shared";
import { describe, expect, test } from "vitest";
import { getHeaderValue, parseMetaHeader } from "./meta-header";

const metaHeaderKey = META_HEADER.toLowerCase();

describe("parseMetaHeader", () => {
  test("parses all three segments", () => {
    const result = parseMetaHeader({
      [metaHeaderKey]: "my-agent/exec-123/session-456",
    });

    expect(result).toEqual({
      externalAgentId: "my-agent",
      executionId: "exec-123",
      sessionId: "session-456",
    });
  });

  test("returns empty object when header is missing", () => {
    const result = parseMetaHeader({});

    expect(result).toEqual({});
  });

  test("returns empty object when header is whitespace-only", () => {
    const result = parseMetaHeader({ [metaHeaderKey]: "   " });

    expect(result).toEqual({});
  });

  test("parses only first segment when no slashes", () => {
    const result = parseMetaHeader({ [metaHeaderKey]: "my-agent" });

    expect(result).toEqual({
      externalAgentId: "my-agent",
    });
  });

  test("handles empty first segment", () => {
    const result = parseMetaHeader({
      [metaHeaderKey]: "/exec-123/session-456",
    });

    expect(result).toEqual({
      executionId: "exec-123",
      sessionId: "session-456",
    });
  });

  test("handles empty second segment", () => {
    const result = parseMetaHeader({
      [metaHeaderKey]: "my-agent//session-456",
    });

    expect(result).toEqual({
      externalAgentId: "my-agent",
      sessionId: "session-456",
    });
  });

  test("handles empty third segment", () => {
    const result = parseMetaHeader({ [metaHeaderKey]: "my-agent/exec-123/" });

    expect(result).toEqual({
      externalAgentId: "my-agent",
      executionId: "exec-123",
    });
  });

  test("sets only execution-id when first and third are empty", () => {
    const result = parseMetaHeader({ [metaHeaderKey]: "/exec-123/" });

    expect(result).toEqual({
      executionId: "exec-123",
    });
  });

  test("returns empty object when all segments are empty", () => {
    const result = parseMetaHeader({ [metaHeaderKey]: "//" });

    expect(result).toEqual({});
  });

  test("handles array header values", () => {
    const result = parseMetaHeader({
      [metaHeaderKey]: ["agent/exec/session", "ignored"],
    });

    expect(result).toEqual({
      externalAgentId: "agent",
      executionId: "exec",
      sessionId: "session",
    });
  });

  test("trims whitespace from segments", () => {
    const result = parseMetaHeader({
      [metaHeaderKey]: " my-agent / exec-123 / session-456 ",
    });

    expect(result).toEqual({
      externalAgentId: "my-agent",
      executionId: "exec-123",
      sessionId: "session-456",
    });
  });

  test("ignores segments beyond the third", () => {
    const result = parseMetaHeader({
      [metaHeaderKey]: "agent/exec/session/extra",
    });

    expect(result).toEqual({
      externalAgentId: "agent",
      executionId: "exec",
      sessionId: "session",
    });
  });
});

describe("getHeaderValue", () => {
  test("returns string header value", () => {
    expect(getHeaderValue({ "x-test": "value" }, "X-Test")).toBe("value");
  });

  test("returns first element of array header", () => {
    expect(getHeaderValue({ "x-test": ["first", "second"] }, "X-Test")).toBe(
      "first",
    );
  });

  test("returns undefined for missing header", () => {
    expect(getHeaderValue({}, "X-Test")).toBeUndefined();
  });

  test("returns undefined for empty string", () => {
    expect(getHeaderValue({ "x-test": "" }, "X-Test")).toBeUndefined();
  });

  test("returns undefined for whitespace-only string", () => {
    expect(getHeaderValue({ "x-test": "   " }, "X-Test")).toBeUndefined();
  });

  test("returns undefined for empty array", () => {
    expect(getHeaderValue({ "x-test": [] }, "X-Test")).toBeUndefined();
  });

  test("returns undefined for array with empty string", () => {
    expect(getHeaderValue({ "x-test": [""] }, "X-Test")).toBeUndefined();
  });

  test("trims returned value", () => {
    expect(getHeaderValue({ "x-test": "  value  " }, "X-Test")).toBe("value");
  });

  test("is case-insensitive for header name", () => {
    expect(
      getHeaderValue(
        { [EXTERNAL_AGENT_ID_HEADER.toLowerCase()]: "agent-1" },
        EXTERNAL_AGENT_ID_HEADER,
      ),
    ).toBe("agent-1");
    expect(
      getHeaderValue(
        { [EXECUTION_ID_HEADER.toLowerCase()]: "exec-1" },
        EXECUTION_ID_HEADER,
      ),
    ).toBe("exec-1");
  });
});
