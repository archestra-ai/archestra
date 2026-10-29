import { describe, expect, test } from "vitest";
import { formatAppa, parseAppa } from "./appa-language";

describe("formatAppa", () => {
  test("normalizes indentation, spacing and step separation", () => {
    const messy = [
      "# Mail",
      "mcp/gmail/read_email {",
      '    id :  "18c9f2"   ',
      "}",
      "expect   allow",
      "mcp/gmail/send_email {}",
      "",
      "",
      "expect authority hitl",
    ].join("\n");

    expect(formatAppa(messy)).toBe(
      [
        "# Mail",
        "mcp/gmail/read_email {",
        '  id: "18c9f2"',
        "}",
        "expect allow",
        "",
        "mcp/gmail/send_email {}",
        "expect authority hitl",
        "",
      ].join("\n"),
    );
  });

  test("is stable on formatted input", () => {
    const formatted =
      'mcp/files/read {\n  path: "/hr/salaries.csv"\n}\nexpect allow\n';
    expect(formatAppa(formatted)).toBe(formatted);
  });
});

describe("parseAppa", () => {
  test("finds each step from its call through its expect line", () => {
    const { steps, errors } = parseAppa([
      "# a comment",
      "mcp/files/read {",
      '  path: "/etc/secrets"',
      "}",
      "expect allow",
      "",
      "agent/kagent/wipe {}",
      "expect authority hitl",
    ]);
    expect(errors).toEqual([]);
    expect(steps).toEqual([
      { line: 2, endLine: 5 },
      { line: 7, endLine: 8 },
    ]);
  });

  test("reports the mistakes the replay parser rejects, on their lines", () => {
    const { errors } = parseAppa([
      "mcp/files/read {",
      "  path: secret",
      '  path: "b"',
      "}",
      "expect maybe",
      "expect allow",
      "mcp/mail/send {",
    ]);
    expect(errors.map((error) => error.line)).toEqual([2, 3, 5, 6, 7]);
    expect(errors[0].message).toContain("must be JSON");
    expect(errors[1].message).toContain("already set");
    expect(errors[2].message).toContain("after the call at line 1");
    expect(errors[3].message).toContain("Expected a tool call");
    expect(errors[4].message).toContain("missing its closing");
  });

  test("flags a call that never states its expectation", () => {
    const { errors } = parseAppa(["mcp/files/list {}"]);
    expect(errors).toEqual([
      expect.objectContaining({
        line: 1,
        message: expect.stringContaining("no `expect` line"),
      }),
    ]);
  });
});
