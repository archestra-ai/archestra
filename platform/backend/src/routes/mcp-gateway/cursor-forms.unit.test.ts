import { describe, expect, test } from "vitest";
import { cursorFormSchema, isCursorClient } from "./cursor-forms";

describe("question forms for Cursor", () => {
  test("Cursor is known by its MCP client's user agent", () => {
    expect(isCursorClient("Cursor/3.30.14 (win32 x64)")).toBe(true);
    expect(isCursorClient("claude-code/2.1.0")).toBe(false);
    expect(isCursorClient("my-cursor/1.0")).toBe(false);
    expect(isCursorClient(undefined)).toBe(false);
  });

  test("a checkbox names its option, and a text field its purpose", () => {
    // Cursor shows a checkbox's description and nothing else, so an option
    // without one read "Enable option_1".
    expect(
      cursorFormSchema({
        type: "object",
        properties: {
          option_0: {
            type: "boolean",
            title: "Red",
            description: "A warm color",
            default: false,
          },
          option_1: { type: "boolean", title: "Green", default: false },
          archestra_other_answer: { type: "string", title: "Type something" },
        },
        required: [],
      }),
    ).toEqual({
      type: "object",
      properties: {
        option_0: {
          type: "boolean",
          title: "Red",
          description: "Red: A warm color",
          default: false,
        },
        option_1: {
          type: "boolean",
          title: "Green",
          description: "Green",
          default: false,
        },
        archestra_other_answer: {
          type: "string",
          title: "Type something",
          description: "Type something",
        },
      },
      required: [],
    });
  });

  test("a single choice is left as it is", () => {
    const schema = {
      type: "object",
      properties: {
        choice: {
          type: "string",
          title: "Decision",
          enum: ["Approve", "Deny"],
        },
      },
      required: ["choice"],
    };
    expect(cursorFormSchema(schema)).toEqual(schema);
    expect(cursorFormSchema(undefined)).toBeUndefined();
  });
});
