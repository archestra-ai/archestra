// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  getDefaultValues,
  getElicitationFields,
  hasChoiceSelection,
  validateValues,
} from "./mcp-elicitation-fields";

describe("choice-form answered validation", () => {
  it("agrees that an all-optional multi-checkbox form is complete unchecked", () => {
    const fields = getElicitationFields({
      type: "object",
      properties: {
        option_0: { type: "boolean", title: "Run tests", default: false },
        option_1: { type: "boolean", title: "Deploy", default: false },
      },
    });
    const values = getDefaultValues(fields);

    expect(Object.keys(validateValues(fields, values))).toEqual([]);
    expect(hasChoiceSelection(fields, values)).toBe(true);
  });

  it("blocks a required choice until it has a value", () => {
    const fields = getElicitationFields({
      type: "object",
      properties: {
        choice: { type: "string", title: "Choice", enum: ["A", "B"] },
      },
      required: ["choice"],
    });
    const values = getDefaultValues(fields);

    expect(validateValues(fields, values).choice).toBe("Choice is required.");
    expect(hasChoiceSelection(fields, values)).toBe(false);

    values.choice = "A";
    expect(Object.keys(validateValues(fields, values))).toEqual([]);
    expect(hasChoiceSelection(fields, values)).toBe(true);
  });
});
