import { describe, expect, test } from "vitest";
import type { AskUserArguments } from "../types";
import {
  claudeDesktopGroupedAnswer,
  claudeDesktopQuestion,
  claudeOversizedQuestion,
} from "./claude-question";

function question(count: number, allowMultiple = false): AskUserArguments {
  return {
    question: "Which color do you prefer?",
    header: "Favorite color",
    options: Array.from({ length: count }, (_, index) => ({
      label: `Color ${index + 1}`,
      description: `Description ${index + 1}`,
    })),
    allowMultiple,
  };
}

function answer(
  asked: AskUserArguments,
  picks: Record<number, string | string[]>,
) {
  const { questions } = claudeDesktopQuestion(asked);
  return {
    content: JSON.stringify({
      answers: Object.fromEntries(
        questions.map((group, index) => [
          group.question,
          picks[index] ?? group.options.at(-1)?.label,
        ]),
      ),
    }),
  };
}

describe("Claude Desktop gateway question groups", () => {
  test("repairs a directly generated five-option native question before validation", () => {
    const asked = question(5);
    const repaired = claudeOversizedQuestion({
      questions: [
        {
          question: asked.question,
          header: asked.header,
          options: asked.options,
          multiSelect: false,
        },
      ],
    });
    expect(repaired).toEqual(asked);
    expect(
      claudeDesktopQuestion(repaired as AskUserArguments).questions,
    ).toHaveLength(2);
    expect(
      claudeOversizedQuestion({
        questions: [
          { question: asked.question, options: asked.options.slice(0, 4) },
        ],
      }),
    ).toBeUndefined();
  });

  test.each([
    2, 4, 5, 7, 12,
  ])("keeps all %i choices within Claude's native limits", (count) => {
    const asked = question(count);
    const { questions } = claudeDesktopQuestion(asked);
    expect(questions.length).toBeLessThanOrEqual(4);
    for (const group of questions) {
      expect(group.options.length).toBeGreaterThanOrEqual(2);
      expect(group.options.length).toBeLessThanOrEqual(4);
      expect(group.header.length).toBeLessThanOrEqual(12);
    }
    const originals = questions.flatMap((group) =>
      group.options.filter((option) =>
        asked.options.some((original) => original.label === option.label),
      ),
    );
    expect(originals).toEqual(
      asked.options.map(({ label, description }) => ({ label, description })),
    );
  });

  test.each([
    4, 5, 12,
  ])("returns the last of %i choices and removes group skips", (count) => {
    const asked = question(count);
    const lastGroup = claudeDesktopQuestion(asked).questions.length - 1;
    expect(
      JSON.parse(
        claudeDesktopGroupedAnswer(
          answer(asked, { [lastGroup]: `Color ${count}` }),
          asked,
        ),
      ),
    ).toEqual({ action: "accept", selected: [`Color ${count}`] });
  });

  test("reads the native text response for all four groups", () => {
    const asked = question(12);
    const groups = claudeDesktopQuestion(asked).questions;
    const pairs = groups.map(
      (group, index) =>
        `"${group.question}"="${index === 3 ? "Color 12" : group.options.at(-1)?.label}"`,
    );
    expect(
      JSON.parse(
        claudeDesktopGroupedAnswer(
          {
            content: `User has answered your questions: ${pairs.join(", ")}. You can now continue with the user's answers in mind.`,
          },
          asked,
        ),
      ),
    ).toEqual({ action: "accept", selected: ["Color 12"] });
  });

  test("collects multiple choices across groups, including reversed text order", () => {
    const asked = question(12, true);
    expect(
      JSON.parse(
        claudeDesktopGroupedAnswer(
          answer(asked, { 0: "Color 3, Color 1", 3: ["Color 12"] }),
          asked,
        ),
      ),
    ).toEqual({
      action: "accept",
      selected: ["Color 1", "Color 3", "Color 12"],
    });
  });

  test("does not accept several groups for a single-choice question", () => {
    const asked = question(5);
    expect(
      JSON.parse(
        claudeDesktopGroupedAnswer(
          answer(asked, { 0: "Color 1", 1: "Color 5" }),
          asked,
        ),
      ),
    ).toMatchObject({ error: "multiple_choices", selected: [] });
  });

  test("does not confuse an original label with a group skip", () => {
    const asked = question(5);
    asked.options[0].label = "No choice in group 1";
    const groups = claudeDesktopQuestion(asked).questions;
    expect(groups[0].options.at(-1)?.label).toBe("No choice in group 1.");
    expect(
      JSON.parse(
        claudeDesktopGroupedAnswer(
          answer(asked, { 0: "No choice in group 1" }),
          asked,
        ),
      ),
    ).toEqual({ action: "accept", selected: ["No choice in group 1"] });
  });

  test("does not guess when a joined answer has two possible interpretations", () => {
    const asked = question(5, true);
    asked.options[0].label = "Red";
    asked.options[1].label = "Blue";
    asked.options[2].label = "Red, Blue";
    expect(
      JSON.parse(
        claudeDesktopGroupedAnswer(answer(asked, { 0: "Red, Blue" }), asked),
      ),
    ).toMatchObject({ error: "unconfirmed_answer", selected: [] });
    expect(
      JSON.parse(
        claudeDesktopGroupedAnswer(answer(asked, { 0: ["Red, Blue"] }), asked),
      ),
    ).toEqual({ action: "accept", selected: ["Red, Blue"] });
    asked.allowMultiple = false;
    expect(
      JSON.parse(
        claudeDesktopGroupedAnswer(answer(asked, { 0: "Red, Blue" }), asked),
      ),
    ).toEqual({ action: "accept", selected: ["Red, Blue"] });
  });

  test("keeps typed answers and never invents a selection after dismissal", () => {
    const asked = question(5);
    expect(
      JSON.parse(
        claudeDesktopGroupedAnswer(
          answer(asked, { 1: "  Turquoise  " }),
          asked,
        ),
      ),
    ).toEqual({ action: "accept", selected: [], text: "Turquoise" });
    const groups = claudeDesktopQuestion(asked).questions;
    expect(
      JSON.parse(
        claudeDesktopGroupedAnswer(
          {
            content: `The user answered: "${groups[0].question}"="${groups[0].options.at(-1)?.label}", "${groups[1].question}"="Turquoise". Read the answers carefully and continue.`,
          },
          asked,
        ),
      ),
    ).toEqual({ action: "accept", selected: [], text: "Turquoise" });
    expect(
      JSON.parse(
        claudeDesktopGroupedAnswer(
          { content: "User dismissed the question." },
          asked,
        ),
      ),
    ).toMatchObject({ action: "decline", selected: [] });
    expect(
      JSON.parse(
        claudeDesktopGroupedAnswer(
          { content: '{"answers":{"unrelated":"Color 5"}}' },
          asked,
        ),
      ),
    ).toMatchObject({ error: "unconfirmed_answer", selected: [] });
  });
});
