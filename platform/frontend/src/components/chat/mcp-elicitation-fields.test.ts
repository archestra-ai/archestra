// @vitest-environment node

import { ASK_USER_OTHER_ANSWER_FIELD } from "@archestra/shared";
import { describe, expect, it } from "vitest";
import {
  type ChatMcpElicitationRequest,
  getComposerAnswer,
  getDefaultValues,
  getElicitationFields,
  hasChoiceSelection,
  takesComposerAnswer,
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

describe("getComposerAnswer", () => {
  const question = (
    id: string,
    properties: Record<string, unknown>,
  ): ChatMcpElicitationRequest => ({
    id,
    conversationId: "c-1",
    toolName: "ask_user",
    message: "Which instrument?",
    mode: "form",
    requestedSchema: { type: "object", properties, required: [] },
  });
  const withTypedAnswer = {
    choice: { type: "string", enum: ["Piano", "Guitar"] },
    [ASK_USER_OTHER_ANSWER_FIELD]: { type: "string", title: "Type something" },
  };

  it("sends composer text as the typed answer of the one open question", () => {
    expect(
      getComposerAnswer({
        requests: [question("q-1", withTypedAnswer)],
        text: "  Cello ",
      }),
    ).toEqual({
      id: "q-1",
      action: "accept",
      content: { choice: "", [ASK_USER_OTHER_ANSWER_FIELD]: "Cello" },
    });
  });

  it("leaves the message alone when it cannot answer exactly one question", () => {
    expect(
      getComposerAnswer({
        requests: [question("q-1", withTypedAnswer)],
        text: "   ",
      }),
    ).toBeNull();
    expect(
      getComposerAnswer({
        requests: [
          question("q-1", withTypedAnswer),
          question("q-2", withTypedAnswer),
        ],
        text: "Cello",
      }),
    ).toBeNull();
    expect(
      getComposerAnswer({
        requests: [
          question("q-1", { choice: { type: "string", enum: ["A", "B"] } }),
        ],
        text: "Cello",
      }),
    ).toBeNull();
  });

  it("marks the composer as answering only while one typed-answer question waits", () => {
    expect(takesComposerAnswer([question("q-1", withTypedAnswer)])).toBe(true);
    expect(takesComposerAnswer([])).toBe(false);
    expect(
      takesComposerAnswer([
        question("q-1", withTypedAnswer),
        question("q-2", withTypedAnswer),
      ]),
    ).toBe(false);
    expect(
      takesComposerAnswer([
        question("q-1", { choice: { type: "string", enum: ["A", "B"] } }),
      ]),
    ).toBe(false);
  });
});
