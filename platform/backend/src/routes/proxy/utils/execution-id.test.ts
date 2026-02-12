import { EXECUTION_ID_HEADER, META_HEADER } from "@shared";
import { describe, expect, test } from "vitest";
import { getExecutionId } from "./execution-id";

const executionHeaderKey = EXECUTION_ID_HEADER.toLowerCase();
const metaHeaderKey = META_HEADER.toLowerCase();

describe("getExecutionId", () => {
  test("extracts execution ID from explicit header", () => {
    const result = getExecutionId({ [executionHeaderKey]: "exec-123" });

    expect(result).toBe("exec-123");
  });

  test("falls back to meta header second segment", () => {
    const result = getExecutionId({
      [metaHeaderKey]: "agent-1/exec-456/session-1",
    });

    expect(result).toBe("exec-456");
  });

  test("explicit header takes precedence over meta header", () => {
    const result = getExecutionId({
      [executionHeaderKey]: "explicit-exec",
      [metaHeaderKey]: "agent/meta-exec/session",
    });

    expect(result).toBe("explicit-exec");
  });

  test("returns undefined when no execution ID is available", () => {
    const result = getExecutionId({});

    expect(result).toBeUndefined();
  });

  test("returns undefined when meta header has empty execution segment", () => {
    const result = getExecutionId({ [metaHeaderKey]: "agent//session" });

    expect(result).toBeUndefined();
  });

  test("handles array header values", () => {
    const result = getExecutionId({
      [executionHeaderKey]: ["exec-first", "exec-second"],
    });

    expect(result).toBe("exec-first");
  });

  test("ignores whitespace-only explicit header and falls back to meta", () => {
    const result = getExecutionId({
      [executionHeaderKey]: "   ",
      [metaHeaderKey]: "agent/meta-exec/session",
    });

    expect(result).toBe("meta-exec");
  });

  test("trims explicit header value", () => {
    const result = getExecutionId({ [executionHeaderKey]: "  exec-123  " });

    expect(result).toBe("exec-123");
  });
});
