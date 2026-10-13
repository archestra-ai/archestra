import { describe, expect, it } from "vitest";
import type { Interaction } from "./common";
import JevDecisionsInteraction from "./jev";

function interaction(
  request: Record<string, unknown>,
  response: Record<string, unknown>,
): Interaction {
  return {
    type: "jev:decisions",
    request,
    response,
    model: "jev-1.13.0",
  } as unknown as Interaction;
}

describe("JevDecisionsInteraction", () => {
  it("shows the state as the user turn and one line per answer", () => {
    const utils = new JevDecisionsInteraction(
      interaction(
        {
          model: "jev-1.13.0",
          state: { tool: "github__delete_repo", arguments: { repo: "a/b" } },
          questions: {},
        },
        {
          answers: {
            delta_trust: {
              type: "choice",
              choice: "trusted",
              probabilities: { trusted: 0.8, suspicious: 0.2 },
            },
            requires_trusted: { type: "noul", noul: 0.912 },
            severity: { type: "score", score: 3, confidence: 0.7 },
          },
        },
      ),
    );

    expect(utils.getLastUserMessage()).toBe(
      '{"tool":"github__delete_repo","arguments":{"repo":"a/b"}}',
    );
    expect(utils.getLastAssistantResponse()).toBe(
      [
        "delta_trust: trusted (p=0.80)",
        "requires_trusted: p(true)=0.91",
        "severity: 3 (p=0.70)",
      ].join("\n"),
    );
    expect(utils.mapToUiMessages().map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
  });

  it("shows nothing for a failed decision with no answers", () => {
    const utils = new JevDecisionsInteraction(
      interaction(
        { model: "jev-1.13.0", state: "plain text", questions: {} },
        { error: "Insufficient credits" },
      ),
    );

    expect(utils.getLastUserMessage()).toBe("plain text");
    expect(utils.getLastAssistantResponse()).toBe("");
    expect(utils.mapToUiMessages()).toHaveLength(1);
  });
});
