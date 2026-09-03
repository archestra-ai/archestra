import { META_HEADER, RUN_ID_HEADER } from "@archestra/shared";
import { describe, expect, test } from "vitest";
import { getRunId } from "./run-id";

const runHeaderKey = RUN_ID_HEADER.toLowerCase();
const metaHeaderKey = META_HEADER.toLowerCase();

describe("getRunId", () => {
  test("extracts execution ID from explicit header", () => {
    const result = getRunId({ [runHeaderKey]: "exec-123" });

    expect(result).toBe("exec-123");
  });

  test("falls back to meta header second segment", () => {
    const result = getRunId({
      [metaHeaderKey]: "agent-1/exec-456/session-1",
    });

    expect(result).toBe("exec-456");
  });

  test("explicit header takes precedence over meta header", () => {
    const result = getRunId({
      [runHeaderKey]: "explicit-exec",
      [metaHeaderKey]: "agent/meta-exec/session",
    });

    expect(result).toBe("explicit-exec");
  });

  test("returns undefined when no execution ID is available", () => {
    const result = getRunId({});

    expect(result).toBeUndefined();
  });

  test("returns undefined when meta header has empty execution segment", () => {
    const result = getRunId({ [metaHeaderKey]: "agent//session" });

    expect(result).toBeUndefined();
  });

  test("handles array header values", () => {
    const result = getRunId({
      [runHeaderKey]: ["exec-first", "exec-second"],
    });

    expect(result).toBe("exec-first");
  });

  test("ignores whitespace-only explicit header and falls back to meta", () => {
    const result = getRunId({
      [runHeaderKey]: "   ",
      [metaHeaderKey]: "agent/meta-exec/session",
    });

    expect(result).toBe("meta-exec");
  });

  test("trims explicit header value", () => {
    const result = getRunId({ [runHeaderKey]: "  exec-123  " });

    expect(result).toBe("exec-123");
  });
});
