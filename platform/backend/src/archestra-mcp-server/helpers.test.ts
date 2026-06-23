import { z } from "zod";
import { describe, expect, test } from "@/test";
import {
  deduplicateLabels,
  formatAssignmentSummary,
  formatZodErrorWithSchema,
  isAbortLikeError,
} from "./helpers";

describe("isAbortLikeError", () => {
  test("returns true for AbortError", () => {
    const error = new DOMException("The operation was aborted", "AbortError");
    expect(isAbortLikeError(error)).toBe(true);
  });

  test("returns true for error message containing abort", () => {
    const error = new Error("Request was aborted by client");
    expect(isAbortLikeError(error)).toBe(true);
  });

  test("returns false for non-Error values", () => {
    expect(isAbortLikeError("not an error")).toBe(false);
    expect(isAbortLikeError(null)).toBe(false);
    expect(isAbortLikeError(42)).toBe(false);
  });

  test("returns false for unrelated errors", () => {
    expect(isAbortLikeError(new Error("Connection timeout"))).toBe(false);
  });
});

describe("formatAssignmentSummary", () => {
  test("appends tool assignment results to lines", () => {
    const lines: string[] = ["Header"];
    formatAssignmentSummary(
      lines,
      [],
      [
        { toolId: "tool-1", status: "success" },
        { toolId: "tool-2", status: "error", error: "validation failed" },
      ],
    );

    expect(lines).toContain("Tool Assignments:");
    expect(lines.some((l) => l.includes("tool-1: success"))).toBe(true);
    expect(
      lines.some((l) => l.includes("tool-2: error - validation failed")),
    ).toBe(true);
  });

  test("appends sub-agent results to lines", () => {
    const lines: string[] = [];
    formatAssignmentSummary(lines, [{ id: "agent-1", status: "success" }]);
    expect(lines).toContain("Sub-Agent Delegations:");
  });

  test("does nothing when both arrays are empty", () => {
    const lines: string[] = ["Initial"];
    formatAssignmentSummary(lines, []);
    expect(lines).toEqual(["Initial"]);
  });
});

describe("deduplicateLabels", () => {
  test("removes duplicate keys keeping last value", () => {
    const result = deduplicateLabels([
      { key: "env", value: "staging" },
      { key: "team", value: "platform" },
      { key: "env", value: "production" },
    ]);
    expect(result).toEqual([
      { key: "env", value: "production" },
      { key: "team", value: "platform" },
    ]);
  });

  test("returns empty array for empty input", () => {
    expect(deduplicateLabels([])).toEqual([]);
  });

  test("passes through unique labels unchanged", () => {
    const labels = [
      { key: "a", value: "1" },
      { key: "b", value: "2" },
    ];
    expect(deduplicateLabels(labels)).toEqual(labels);
  });
});

describe("formatZodErrorWithSchema", () => {
  // mirrors the sandbox upload `source` shape: a discriminated union nested
  // under an object key — the case a model could not recover from.
  const nestedSchema = z.strictObject({
    path: z.string(),
    source: z.discriminatedUnion("type", [
      z.strictObject({ type: z.literal("base64"), dataBase64: z.string() }),
      z.strictObject({ type: z.literal("text"), text: z.string() }),
    ]),
  });

  function parseError(schema: z.ZodType, value: unknown): z.ZodError {
    const result = schema.safeParse(value);
    if (result.success) throw new Error("expected a validation failure");
    return result.error;
  }

  test("enumerates discriminator values for a missing discriminator", () => {
    const error = parseError(nestedSchema, { path: "out", source: {} });
    expect(formatZodErrorWithSchema(error, nestedSchema)).toBe(
      'source.type: set "type" to one of: "base64", "text"',
    );
  });

  test("enumerates for a wrong discriminator value", () => {
    const error = parseError(nestedSchema, {
      path: "out",
      source: { type: "inline", text: "hi" },
    });
    expect(formatZodErrorWithSchema(error, nestedSchema)).toBe(
      'source.type: set "type" to one of: "base64", "text"',
    );
  });

  test("enumerates for a top-level discriminated union", () => {
    const schema = z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("a"), a: z.string() }),
      z.strictObject({ kind: z.literal("b"), b: z.string() }),
    ]);
    const error = parseError(schema, {});
    expect(formatZodErrorWithSchema(error, schema)).toBe(
      'kind: set "kind" to one of: "a", "b"',
    );
  });

  test("falls through to the field error once the variant is selected", () => {
    const error = parseError(nestedSchema, {
      path: "out",
      source: { type: "text" },
    });
    // a valid discriminator + missing field must not be masked by enumeration.
    expect(formatZodErrorWithSchema(error, nestedSchema)).toContain(
      "source.text:",
    );
    expect(formatZodErrorWithSchema(error, nestedSchema)).not.toContain(
      'set "type"',
    );
  });

  test("leaves non-union errors unchanged", () => {
    const schema = z.strictObject({ name: z.string() });
    const error = parseError(schema, { name: 123 });
    const message = formatZodErrorWithSchema(error, schema);
    expect(message).toContain("name:");
    expect(message).not.toContain('set "');
  });

  test("renders non-string discriminator literals", () => {
    const schema = z.discriminatedUnion("v", [
      z.strictObject({ v: z.literal(1), a: z.string() }),
      z.strictObject({ v: z.literal(2), b: z.string() }),
    ]);
    const error = parseError(schema, {});
    expect(formatZodErrorWithSchema(error, schema)).toBe(
      'v: set "v" to one of: 1, 2',
    );
  });

  test("bails to the plain message for a non-literal (enum) discriminator", () => {
    const schema = z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.enum(["a", "b"]), x: z.string() }),
      z.strictObject({ kind: z.literal("c"), y: z.string() }),
    ]);
    const error = parseError(schema, {});
    // an incomplete menu would mislead, so we fall back rather than list a subset.
    expect(formatZodErrorWithSchema(error, schema)).not.toContain('set "kind"');
  });

  test("falls back gracefully for a union nested inside a union option", () => {
    const schema = z.discriminatedUnion("outer", [
      z.strictObject({
        outer: z.literal("nested"),
        inner: z.discriminatedUnion("type", [
          z.strictObject({ type: z.literal("a"), a: z.string() }),
          z.strictObject({ type: z.literal("b"), b: z.string() }),
        ]),
      }),
      z.strictObject({ outer: z.literal("flat"), n: z.number() }),
    ]);
    // the inner discriminator failure sits at ["inner","type"]; navigateSchema
    // cannot descend through the outer union's variant, so it must not throw and
    // must leave a usable (plain) message.
    const error = parseError(schema, { outer: "nested", inner: {} });
    expect(() => formatZodErrorWithSchema(error, schema)).not.toThrow();
  });

  test("lists valid keys and suggests the closest for an unrecognized key", () => {
    const schema = z.strictObject({
      command: z.string(),
      timeoutSeconds: z.number().optional(),
    });
    const error = parseError(schema, { command: "ls", timeout: 5 });
    const message = formatZodErrorWithSchema(error, schema);
    // a truncated name (`timeout` → `timeoutSeconds`) is matched by substring,
    // not edit distance, which would be far too large.
    expect(message).toBe(
      'unrecognized key "timeout" (did you mean "timeoutSeconds"?) — ' +
        'valid keys are "command", "timeoutSeconds"',
    );
  });

  test("suggests the closest key for an ordinary typo", () => {
    const schema = z.strictObject({ command: z.string(), cwd: z.string() });
    const error = parseError(schema, { commnd: "ls" });
    expect(formatZodErrorWithSchema(error, schema)).toContain(
      'did you mean "command"?',
    );
  });

  test("reports every unrecognized key in one issue", () => {
    const schema = z.strictObject({ command: z.string() });
    const error = parseError(schema, { command: "ls", foo: 1, bar: 2 });
    const message = formatZodErrorWithSchema(error, schema);
    expect(message).toContain("unrecognized keys");
    expect(message).toContain('"foo"');
    expect(message).toContain('"bar"');
    expect(message).toContain('valid keys are "command"');
  });

  test("omits a coincidental edit-distance match on short keys", () => {
    // `cmd` is one edit from `cwd` but four from `command`; suggesting `cwd`
    // would mislead, so on short keys we list the valid keys without guessing.
    const schema = z.strictObject({ command: z.string(), cwd: z.string() });
    const error = parseError(schema, { cmd: "ls" });
    const message = formatZodErrorWithSchema(error, schema);
    expect(message).not.toContain("did you mean");
    expect(message).toContain('valid keys are "command", "cwd"');
  });

  test("omits a suggestion when no key is close", () => {
    const schema = z.strictObject({ command: z.string() });
    const error = parseError(schema, { command: "ls", xyzzy: 1 });
    const message = formatZodErrorWithSchema(error, schema);
    expect(message).toContain('unrecognized key "xyzzy"');
    expect(message).not.toContain("did you mean");
  });

  test("prefixes the path for an unrecognized key on a nested object", () => {
    const schema = z.strictObject({
      nested: z.strictObject({ command: z.string() }),
    });
    const error = parseError(schema, { nested: { command: "ls", timeout: 5 } });
    expect(formatZodErrorWithSchema(error, schema)).toContain(
      'nested: unrecognized key "timeout"',
    );
  });
});
